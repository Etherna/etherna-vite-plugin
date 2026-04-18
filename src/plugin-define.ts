import chalk from "chalk"

import { assertValidGithubRepo, resolveShkeeperImageName } from "./builder"
import { isBlockchainBootstrapInProgress, waitForBlockchainBootstrapToSettle } from "./docker"
import { removePortlessAliases, stopPortlessProxy } from "./portless"

import type {
  BeeEnv,
  BeehiveEnv,
  CreditEnv,
  ElasticEnv,
  GatewayEnv,
  IndexEnv,
  MongoEnv,
  ShkeeperEnv,
  ShkeeperEthereumEnv,
  SsoEnv,
} from "./envs"
import type { PortlessServiceAlias } from "./portless"
import type { ChildProcess } from "node:child_process"
import type { ViteDevServer } from "vite"

interface ServiceEnvByKey {
  elastic: ElasticEnv
  mongo: MongoEnv
  bee: BeeEnv
  sso: SsoEnv
  index: IndexEnv
  gateway: GatewayEnv
  credit: CreditEnv
  beehive: BeehiveEnv
}

export type ServiceKey = keyof ServiceEnvByKey

export interface ServiceConfig<TEnv> {
  enabled?: boolean
  env?: TEnv
}

/**
 * When `githubRepo` is set (`owner/repo`), the plugin builds SHKeeper core from that repository and tags the image as
 * `etherna/shkeeper:…` (same version tag as the default upstream image).
 */
export interface ShkeeperBuildConfig {
  githubRepo?: string
  /** Branch or tag to clone when `githubRepo` is set (defaults to `main`). Ignored for the default upstream build. */
  githubBranch?: string
}

export interface ShkeeperEthereumConfig {
  env?: ShkeeperEthereumEnv
  /** When set, build the adapter from this repo and run `etherna/ethereum-shkeeper:…` instead of the upstream image. */
  githubRepo?: string
  /** Branch or tag to clone when `githubRepo` is set (defaults to `main`). */
  githubBranch?: string
}

export interface ShkeeperConfig extends ServiceConfig<ShkeeperEnv> {
  build?: ShkeeperBuildConfig
  ethereum?: ShkeeperEthereumConfig
}

export interface DockerPluginOptions {
  https?: boolean
  enabled?: boolean
  /** When true, starts Portless on HTTP port 1355 and registers friendly `*.localhost` URLs for the app and enabled HTTP services. */
  portless?: boolean
  elastic?: boolean | ServiceConfig<ElasticEnv>
  mongo?: boolean | ServiceConfig<MongoEnv>
  bee?: boolean | ServiceConfig<BeeEnv>
  sso?: boolean | ServiceConfig<SsoEnv>
  index?: boolean | ServiceConfig<IndexEnv>
  gateway?: boolean | ServiceConfig<GatewayEnv>
  credit?: boolean | ServiceConfig<CreditEnv>
  beehive?: boolean | ServiceConfig<BeehiveEnv>
  shkeeper?: boolean | ShkeeperConfig
}

export function getDevServerPort(server: ViteDevServer, fallbackPort: number): number {
  const addr = server.httpServer?.address()
  if (addr && typeof addr === "object" && "port" in addr && typeof addr.port === "number") {
    return addr.port
  }
  return fallbackPort
}

/** Typed options helper (similar to `defineConfig` in Vite). */
export function defineEthernaPlugin(options: DockerPluginOptions): DockerPluginOptions {
  return options
}

/** Disables HTTPS (not supported yet) and logs once. Mutates `options`. */
export function applyEthernaPluginHttpsFallback(options: DockerPluginOptions): void {
  if (options.https) {
    options.https = false
    console.log(chalk.yellow(`  HTTPS not supported yet. Falling back to HTTP.`))
  }
}

export interface EthernaPluginHarness {
  isServiceEnabled: (service: ServiceKey) => boolean
  getServiceEnv: <K extends ServiceKey>(service: K) => ServiceEnvByKey[K]
  isShkeeperEnabled: () => boolean
  getShkeeperConfig: () => ShkeeperConfig
  getShkeeperBuild: () => {
    githubRepo: string | undefined
    githubBranch: string | undefined
    imageName: string
  }

  isShutdownRequested: () => boolean
  pushSpawn: (...procs: ChildProcess[]) => void
  setPortlessProxyStartedByUs: (started: boolean) => void
  recordPortlessAliases: (aliases: PortlessServiceAlias[]) => void
  cleanupPortless: () => Promise<void>
  killSpawns: () => void
  shutdownServices: (exitProcess?: boolean, force?: boolean) => Promise<void>
  installProcessSignalHandlers: () => void
}

/** Option helpers plus portless cleanup, child-process tracking, and shutdown (closure per plugin instance). */
export function harnessEthernaPlugin(options: DockerPluginOptions): EthernaPluginHarness {
  const spawns: ChildProcess[] = []
  let portlessProxyStartedByUs = false
  const portlessAliasesRegistered: PortlessServiceAlias[] = []
  let shutdownRequested = false
  let shutdownInProgress = false

  const isServiceEnabled = (service: ServiceKey) => {
    return typeof options[service] === "object"
      ? options[service]?.enabled !== false
      : options[service] !== false
  }

  const getServiceEnv = <K extends ServiceKey>(service: K): ServiceEnvByKey[K] => {
    const o = options[service]
    return typeof o === "object" && o !== null ? (o.env ?? {}) : {}
  }

  const isShkeeperEnabled = () => {
    if (options.shkeeper === true) {
      return true
    }

    return typeof options.shkeeper === "object" && options.shkeeper !== null
      ? options.shkeeper.enabled !== false
      : false
  }

  const getShkeeperConfig = (): ShkeeperConfig => {
    if (options.shkeeper === true) {
      return {}
    }

    return typeof options.shkeeper === "object" && options.shkeeper !== null ? options.shkeeper : {}
  }

  const getShkeeperBuild = () => {
    const build = getShkeeperConfig().build
    const githubRepo = build?.githubRepo?.trim()
    if (githubRepo) {
      assertValidGithubRepo(githubRepo)
    }

    return {
      githubRepo: githubRepo || undefined,
      githubBranch: build?.githubBranch?.trim() || undefined,
      imageName: resolveShkeeperImageName(githubRepo || undefined),
    }
  }

  const cleanupPortless = async () => {
    if (portlessAliasesRegistered.length > 0) {
      await removePortlessAliases(portlessAliasesRegistered)
      portlessAliasesRegistered.length = 0
    }
    if (portlessProxyStartedByUs) {
      await stopPortlessProxy()
    }
    portlessProxyStartedByUs = false
  }

  const killSpawns = () => {
    for (const proc of spawns) {
      proc.kill()
    }
  }

  const shutdownServices = async (exitProcess = false, force = false) => {
    shutdownRequested = true

    if (shutdownInProgress && !force) {
      return
    }
    shutdownInProgress = true

    if (!force && isBlockchainBootstrapInProgress()) {
      console.log(
        chalk.yellow(
          `  ➜  ${chalk.bold("etherna-blockchain")}:   Shutdown requested during blockchain initialization. Waiting for a safe shutdown point. Press Ctrl+C again to force exit.`,
        ),
      )
      await waitForBlockchainBootstrapToSettle()
    }

    await cleanupPortless()
    killSpawns()
    if (exitProcess) {
      process.exit(0)
    }
  }

  const installProcessSignalHandlers = () => {
    process.on("SIGINT", () => {
      process.stdin.resume()
      void (async () => {
        await shutdownServices(true, shutdownRequested)
      })()
    })
    process.on("SIGTERM", () => {
      void (async () => {
        await shutdownServices(false, shutdownRequested)
      })()
    })
  }

  return {
    isServiceEnabled,
    getServiceEnv,
    isShkeeperEnabled,
    getShkeeperConfig,
    getShkeeperBuild,

    isShutdownRequested: () => shutdownRequested,
    pushSpawn: (...procs) => {
      spawns.push(...procs)
    },
    setPortlessProxyStartedByUs: (started) => {
      portlessProxyStartedByUs = started
    },
    recordPortlessAliases: (aliases) => {
      portlessAliasesRegistered.push(...aliases)
    },
    cleanupPortless,
    killSpawns,
    shutdownServices,
    installProcessSignalHandlers,
  }
}

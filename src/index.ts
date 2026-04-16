import chalk from "chalk"

import {
  ensureDockerReady,
  isBlockchainBootstrapInProgress,
  startAspContainer,
  startBeeNodes,
  startBlockchain,
  startElasticContainer,
  startMongoDbContainer,
  waitForBlockchainBootstrapToSettle,
} from "./docker"
import {
  buildServiceEnvs,
  defaultServiceEnvBuildContext,
  getEnv,
  parsePortFromAspNetCoreUrls,
} from "./envs"
import {
  ensurePortlessProxy,
  getPortlessPublicUrl,
  isPortlessCliAvailable,
  normalizePortlessAppPublicUrl,
  PORTLESS_URL_ENV,
  registerPortlessAliases,
  removePortlessAliases,
  stopPortlessProxy,
} from "./portless"
import { generateSslCertificate } from "./ssl"

import type {
  BeeEnv,
  BeehiveEnv,
  CreditEnv,
  ElasticEnv,
  GatewayEnv,
  IndexEnv,
  MongoEnv,
  ServiceEnvBuildContext,
  SsoEnv,
} from "./envs"
import type { PortlessServiceAlias } from "./portless"
import type { ChildProcess } from "node:child_process"
import type { Plugin, ServerOptions, ViteDevServer } from "vite"

export type {
  AspServiceEnv,
  BeeEnv,
  BeehiveEnv,
  CreditEnv,
  ElasticEnv,
  GatewayEnv,
  IndexEnv,
  MongoEnv,
  ServiceEnvBuildContext,
  SsoEnv,
} from "./envs"

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

interface ServiceConfig<TEnv> {
  enabled?: boolean
  env?: TEnv
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
}

function getDevServerPort(server: ViteDevServer, fallbackPort: number): number {
  const addr = server.httpServer?.address()
  if (addr && typeof addr === "object" && "port" in addr && typeof addr.port === "number") {
    return addr.port
  }
  return fallbackPort
}

export function etherna(options: DockerPluginOptions = {}): Plugin {
  const spawns = [] as ChildProcess[]

  let portlessProxyStartedByUs = false
  const portlessAliasesRegistered: PortlessServiceAlias[] = []
  let shutdownRequested = false
  let shutdownInProgress = false

  if (options.https) {
    options.https = false
    console.log(chalk.yellow(`  HTTPS not supported yet. Falling back to HTTP.`))
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

  // kill all spawned containers on process exit
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

  const isServiceEnabled = (service: ServiceKey) => {
    return typeof options[service] === "object"
      ? options[service]?.enabled !== false
      : options[service] !== false
  }

  const getServiceEnv = <K extends ServiceKey>(service: K): ServiceEnvByKey[K] => {
    const o = options[service]
    return typeof o === "object" && o !== null ? (o.env ?? {}) : {}
  }

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

  return {
    name: "etherna:vite-plugin",
    apply: "serve",
    async configResolved(config) {
      if (options.https) {
        const { cert, key } = await generateSslCertificate()
        const https = { cert, key } as ServerOptions

        config.server.https = Object.assign({}, config.server.https, https)
        config.preview.https = Object.assign({}, config.preview.https, https)
      }
      const mode: "http" | "https" = options.https ? "https" : "http"
      const defaultCtx = defaultServiceEnvBuildContext(mode)
      config.server.port ??= getEnv("app", defaultCtx).port
    },
    async configureServer(server) {
      // Early return when running in isolated mode or disabled
      if (options.enabled === false) {
        console.log(chalk.yellow(`  Services disabled. Skipping container startup.`))
        return
      }

      await ensureDockerReady()

      const mode: "http" | "https" = options.https ? "https" : "http"

      // Start container once dev server is listening
      server.httpServer?.once("listening", async () => {
        const fallbackPort = getEnv("app", defaultServiceEnvBuildContext(mode)).port
        const appPort = getDevServerPort(server, fallbackPort)

        const portlessAppPublicUrl = process.env[PORTLESS_URL_ENV]?.trim()
        const serviceCtx: ServiceEnvBuildContext = {
          mode,
          portless: Boolean(options.portless),
          appPort,
          ...(options.portless && portlessAppPublicUrl
            ? { portlessAppPublicUrl }
            : {}),
        }

        if (options.portless) {
          if (!(await isPortlessCliAvailable())) {
            console.error(
              chalk.red(
                `  portless: CLI not found. Install globally (recommended): npm install -g portless`,
              ),
            )
            process.exit(1)
          }
          try {
            const { startedByUs } = await ensurePortlessProxy()
            portlessProxyStartedByUs = startedByUs
          } catch (e) {
            console.error(
              chalk.red(
                `  portless: failed to start proxy: ${e instanceof Error ? e.message : String(e)}`,
              ),
            )
            process.exit(1)
          }

          const envs = buildServiceEnvs(serviceCtx)
          const aliasEntries: { name: PortlessServiceAlias; port: number }[] = []
          if (!portlessAppPublicUrl) {
            aliasEntries.push({ name: "app", port: appPort })
          }

          if (isServiceEnabled("sso")) {
            aliasEntries.push({
              name: "sso",
              port: Number.parseInt(
                parsePortFromAspNetCoreUrls(String(envs["etherna-sso"].ASPNETCORE_URLS)),
                10,
              ),
            })
          }
          if (isServiceEnabled("index")) {
            aliasEntries.push({
              name: "index",
              port: Number.parseInt(
                parsePortFromAspNetCoreUrls(String(envs["etherna-index"].ASPNETCORE_URLS)),
                10,
              ),
            })
          }
          if (isServiceEnabled("credit")) {
            aliasEntries.push({
              name: "credit",
              port: Number.parseInt(
                parsePortFromAspNetCoreUrls(String(envs["etherna-credit"].ASPNETCORE_URLS)),
                10,
              ),
            })
          }
          if (isServiceEnabled("gateway")) {
            aliasEntries.push({
              name: "gateway",
              port: Number.parseInt(
                parsePortFromAspNetCoreUrls(String(envs["etherna-gateway"].ASPNETCORE_URLS)),
                10,
              ),
            })
          }
          if (isServiceEnabled("beehive")) {
            aliasEntries.push({
              name: "beehive",
              port: Number.parseInt(
                parsePortFromAspNetCoreUrls(
                  String(envs["etherna-beehive-manager"].ASPNETCORE_URLS),
                ),
                10,
              ),
            })
          }
          if (isServiceEnabled("bee")) {
            const beeBase = getEnv("etherna-bee", serviceCtx) ?? {}
            const beeMerged = { ...beeBase, ...getServiceEnv("bee") }
            const beePort = Number(beeMerged.BEE_PORT ?? 1633)
            aliasEntries.push({ name: "bee", port: beePort })
          }

          try {
            await registerPortlessAliases(aliasEntries)
            portlessAliasesRegistered.push(...aliasEntries.map((e) => e.name))
          } catch (e) {
            console.error(
              chalk.red(
                `  portless: failed to register aliases: ${e instanceof Error ? e.message : String(e)}`,
              ),
            )
            await cleanupPortless()
            process.exit(1)
          }

          const publicAppLabel =
            portlessAppPublicUrl != null && portlessAppPublicUrl !== ""
              ? `${normalizePortlessAppPublicUrl(portlessAppPublicUrl)}/`
              : `${getPortlessPublicUrl("app")}/`
          console.log(
            chalk.green(`  ➜  ${chalk.bold("vite (portless)")}:   ${chalk.cyan(publicAppLabel)}`),
          )
        }

        if (isServiceEnabled("bee")) {
          void startBlockchain(serviceCtx, getServiceEnv("bee"))
            .then((p) => {
              spawns.push(p)
              if (shutdownRequested) {
                return [] as ChildProcess[]
              }
              return startBeeNodes(serviceCtx, getServiceEnv("bee"))
            })
            .then((procs) => {
              if (shutdownRequested) {
                return
              }
              spawns.push(...procs)
            })
            .catch((error: unknown) => {
              if (!shutdownRequested) {
                throw error
              }
            })
        }
        if (isServiceEnabled("elastic")) {
          void startElasticContainer(getServiceEnv("elastic"), serviceCtx).then((p) =>
            spawns.push(p),
          )
        }
        if (isServiceEnabled("mongo")) {
          spawns.push(await startMongoDbContainer(getServiceEnv("mongo"), serviceCtx))
        }
        if (isServiceEnabled("beehive")) {
          void startAspContainer(
            "etherna-beehive-manager",
            "etherna/beehive-manager:latest",
            serviceCtx,
            getServiceEnv("beehive"),
          ).then((p) => spawns.push(p))
        }
        if (isServiceEnabled("index")) {
          void startAspContainer(
            "etherna-index",
            "etherna/etherna-index:latest",
            serviceCtx,
            getServiceEnv("index"),
          ).then((p) => spawns.push(p))
        }
        if (isServiceEnabled("sso")) {
          spawns.push(
            await startAspContainer(
              "etherna-sso",
              "etherna/etherna-sso:latest",
              serviceCtx,
              getServiceEnv("sso"),
            ),
          )
        }
        if (isServiceEnabled("gateway")) {
          void startAspContainer(
            "etherna-gateway",
            "etherna/etherna-gateway:latest",
            serviceCtx,
            getServiceEnv("gateway"),
          ).then((p) => spawns.push(p))
        }
        if (isServiceEnabled("credit")) {
          void startAspContainer(
            "etherna-credit",
            "etherna/etherna-credit:latest",
            serviceCtx,
            getServiceEnv("credit"),
          ).then((p) => spawns.push(p))
        }
      })

      // Stop containers when dev server is closed
      server.httpServer?.once("close", () => {
        void shutdownServices(false)
      })
    },
  }
}

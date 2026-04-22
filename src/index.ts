import chalk from "chalk"
import { loadEnv } from "vite"

import { assertValidGithubRepo } from "./builder"
import { createDependenciesTree } from "./dependencies-tree"
import {
  ensureDockerReady,
  startAspContainer,
  startBeeNodes,
  startBlockchain,
  startElasticContainer,
  startMongoDbContainer,
  startShkeeperStack,
  stopEnabledEthernaContainers,
} from "./docker"
import {
  buildServiceEnvs,
  defaultServiceEnvBuildContext,
  getEnv,
  parsePortFromAspNetCoreUrls,
} from "./envs"
import {
  applyEthernaPluginHttpsFallback,
  getDevServerPort,
  harnessEthernaPlugin,
  type DockerPluginOptions,
  type EthernaPluginHarness,
} from "./plugin-define"
import {
  ensurePortlessProxy,
  getPortlessPublicUrl,
  isPortlessCliAvailable,
  normalizePortlessAppPublicUrl,
  PORTLESS_URL_ENV,
} from "./portless"
import { generateSslCertificate } from "./ssl"
import { fetchFirstShkeeperWalletApiKey, getEnvVar, logError } from "./utils"

import type { ServiceEnvBuildContext } from "./envs"
import type { ChildProcess } from "node:child_process"
import type { Plugin, ServerOptions } from "vite"

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
  ShkeeperEnv,
  ShkeeperEthereumEnv,
  SsoEnv,
} from "./envs"

export { DEFAULT_GITHUB_BRANCH } from "./builder"

export type {
  DockerPluginOptions,
  EthernaPluginHarness,
  ServiceConfig,
  ServiceKey,
  ShkeeperBuildConfig,
  ShkeeperConfig,
  ShkeeperEthereumConfig,
} from "./plugin-define"

export {
  applyEthernaPluginHttpsFallback,
  defineEthernaPlugin,
  ETHERNA_DETACHED_ENV,
  getDevServerPort,
  harnessEthernaPlugin,
  resolveDetachedMode,
} from "./plugin-define"

export type {
  DependencyFailureMode,
  DependencyTreeLogger,
  DependencyTreeRunResult,
  DependencyTreeServiceDefinition,
  DependencyTreeServiceResult,
  DependencyTreeServiceStatus,
} from "./dependencies-tree"
export {
  createDependenciesTree,
  DependencyTreeValidationError,
  validateDependencyTree,
} from "./dependencies-tree"

export { addPortlessAlias, parsePortlessPort } from "./portless"

/** Prefixes loaded from `.env` files into `process.env` by the plugin's `config` hook. */
const ETHERNA_ENV_PREFIXES: string[] = ["ETHERNA_", "PORTLESS_"]

type EthernaStartupHandlers = {
  startBeeBlockchain: () => Promise<boolean>
  startBeeNodes: () => Promise<boolean>
  startShkeeper: () => Promise<boolean>
  startElastic: () => Promise<boolean>
  startMongo: () => Promise<boolean>
  startBeehive: () => Promise<boolean>
  startIndex: () => Promise<boolean>
  startSso: () => Promise<boolean>
  startGateway: () => Promise<boolean>
  startCredit: () => Promise<boolean>
}

function createEthernaStartupHandlers(ctx: {
  serviceCtx: ServiceEnvBuildContext
  getServiceEnv: EthernaPluginHarness["getServiceEnv"]
  pushSpawn: EthernaPluginHarness["pushSpawn"]
  isShutdownRequested: EthernaPluginHarness["isShutdownRequested"]
  getShkeeperConfig: EthernaPluginHarness["getShkeeperConfig"]
  getShkeeperBuild: EthernaPluginHarness["getShkeeperBuild"]
  isShkeeperEnabled: () => boolean
  detached: boolean
}): EthernaStartupHandlers {
  const {
    serviceCtx,
    getServiceEnv,
    pushSpawn,
    isShutdownRequested,
    getShkeeperConfig,
    getShkeeperBuild,
    isShkeeperEnabled,
    detached,
  } = ctx

  const pushSpawnMaybe = (...procs: (ChildProcess | null)[]) => {
    pushSpawn(...procs.filter((p): p is ChildProcess => p != null))
  }

  return {
    async startBeeBlockchain() {
      try {
        const p = await startBlockchain(serviceCtx, getServiceEnv("bee"), { detached })
        pushSpawnMaybe(p)
        return !isShutdownRequested()
      } catch (error: unknown) {
        if (isShutdownRequested()) {
          return false
        }
        throw error
      }
    },
    async startBeeNodes() {
      try {
        const procs = await startBeeNodes(serviceCtx, getServiceEnv("bee"), { detached })
        if (isShutdownRequested()) {
          return false
        }
        pushSpawnMaybe(...procs)
        return !isShutdownRequested()
      } catch (error: unknown) {
        if (isShutdownRequested()) {
          return false
        }
        throw error
      }
    },
    async startShkeeper() {
      const sk = getShkeeperConfig()
      const ethRepo = sk.ethereum?.githubRepo?.trim()
      if (ethRepo) {
        assertValidGithubRepo(ethRepo)
      }
      try {
        const procs = await startShkeeperStack({
          context: serviceCtx,
          build: getShkeeperBuild(),
          coreEnv: sk.env,
          ethereumEnv: sk.ethereum?.env,
          ethereumGithubRepo: ethRepo || undefined,
          ethereumGithubBranch: sk.ethereum?.githubBranch?.trim() || undefined,
          detached,
        })
        pushSpawnMaybe(...procs)
        return !isShutdownRequested()
      } catch (error: unknown) {
        if (isShutdownRequested()) {
          return false
        }
        throw error
      }
    },
    async startElastic() {
      const p = await startElasticContainer(getServiceEnv("elastic"), serviceCtx, { detached })
      pushSpawnMaybe(p)
      return !isShutdownRequested()
    },
    async startMongo() {
      const p = await startMongoDbContainer(getServiceEnv("mongo"), serviceCtx, { detached })
      pushSpawnMaybe(p)
      return !isShutdownRequested()
    },
    async startBeehive() {
      const p = await startAspContainer(
        "etherna-beehive",
        "etherna/beehive:latest",
        serviceCtx,
        getServiceEnv("beehive"),
        { detached },
      )
      pushSpawnMaybe(p)
      return !isShutdownRequested()
    },
    async startIndex() {
      const p = await startAspContainer(
        "etherna-index",
        "etherna/etherna-index:latest",
        serviceCtx,
        getServiceEnv("index"),
        { detached },
      )
      pushSpawnMaybe(p)
      return !isShutdownRequested()
    },
    async startSso() {
      const p = await startAspContainer(
        "etherna-sso",
        "etherna/etherna-sso:latest",
        serviceCtx,
        getServiceEnv("sso"),
        { detached },
      )
      pushSpawnMaybe(p)
      return !isShutdownRequested()
    },
    async startGateway() {
      const p = await startAspContainer(
        "etherna-gateway",
        "etherna/etherna-gateway:latest",
        serviceCtx,
        getServiceEnv("gateway"),
        { detached },
      )
      pushSpawnMaybe(p)
      return !isShutdownRequested()
    },
    async startCredit() {
      try {
        let creditEnv = getServiceEnv("credit")
        if (isShkeeperEnabled()) {
          const apiKey = await fetchFirstShkeeperWalletApiKey()
          if (apiKey) {
            creditEnv = { ...creditEnv, "Payments:ShKeeper:ApiKey": apiKey }
          }
        }
        const p = await startAspContainer(
          "etherna-credit",
          "etherna/etherna-credit:latest",
          serviceCtx,
          creditEnv,
          { detached },
        )
        pushSpawnMaybe(p)
        return !isShutdownRequested()
      } catch (error: unknown) {
        if (isShutdownRequested()) {
          return false
        }
        throw error
      }
    },
  }
}

export function etherna(options: DockerPluginOptions = {}): Plugin {
  const harness = harnessEthernaPlugin(options)
  applyEthernaPluginHttpsFallback(options)
  harness.installProcessSignalHandlers()

  const {
    isServiceEnabled,
    getServiceEnv,
    isShkeeperEnabled,
    getShkeeperConfig,
    getShkeeperBuild,
    getDetached,
    isShutdownRequested,
    pushSpawn,
    setPortlessProxyStartedByUs,
    recordPortlessAlias,
    cleanupPortless,
    shutdownServices,
  } = harness

  return {
    name: "etherna:vite-plugin",
    apply: "serve",
    config(userConfig, { mode }) {
      // Vite doesn't auto-populate `process.env` from `.env` files (those are loaded
      // into client-side `import.meta.env` and filtered by `envPrefix`). The plugin
      // runs in Node and only reads a small, well-known set of variables, so we
      // restrict the merge to those prefixes — keeps the user's other secrets out
      // of `process.env` and avoids cross-plugin contamination.
      const envDir = userConfig.envDir ?? userConfig.root ?? process.cwd()
      const fileEnv = loadEnv(mode, envDir, ETHERNA_ENV_PREFIXES)
      for (const [key, value] of Object.entries(fileEnv)) {
        process.env[key] ??= value
      }
    },
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

        const portlessAppPublicUrl = getEnvVar(PORTLESS_URL_ENV)?.trim()
        const serviceCtx: ServiceEnvBuildContext = {
          mode,
          portless: Boolean(options.portless),
          appPort,
          ...(options.portless && portlessAppPublicUrl ? { portlessAppPublicUrl } : {}),
        }

        let envs: ReturnType<typeof buildServiceEnvs> | undefined
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
            setPortlessProxyStartedByUs(startedByUs)
          } catch (e) {
            console.error(
              chalk.red(
                `  portless: failed to start proxy: ${e instanceof Error ? e.message : String(e)}`,
              ),
            )
            process.exit(1)
          }

          envs = buildServiceEnvs(serviceCtx)
          if (!portlessAppPublicUrl) {
            try {
              await recordPortlessAlias("app", appPort)
            } catch (e) {
              console.error(
                chalk.red(
                  `  portless: failed to register aliases: ${e instanceof Error ? e.message : String(e)}`,
                ),
              )
              await cleanupPortless()
              process.exit(1)
            }
          }

          const publicAppLabel =
            portlessAppPublicUrl != null && portlessAppPublicUrl !== ""
              ? `${normalizePortlessAppPublicUrl(portlessAppPublicUrl)}/`
              : `${getPortlessPublicUrl("app")}/`
          console.log(
            chalk.green(`  ➜  ${chalk.bold("vite (portless)")}:   ${chalk.cyan(publicAppLabel)}`),
          )
        }

        const startup = createEthernaStartupHandlers({
          serviceCtx,
          getServiceEnv,
          pushSpawn,
          isShutdownRequested,
          getShkeeperConfig,
          getShkeeperBuild,
          isShkeeperEnabled,
          detached: getDetached(),
        })

        const tree = createDependenciesTree(
          [
            {
              code: "bee-blockchain",
              enabled: isServiceEnabled("bee"),
              onFailure: "stop",
              beforeStartup: options.portless
                ? async () => {
                  const beeBase = getEnv("etherna-bee", serviceCtx) ?? {}
                  await recordPortlessAlias(
                    "bee",
                    { ...beeBase, ...getServiceEnv("bee") }.BEE_PORT ?? 1633,
                  )
                }
                : undefined,
              startupCallback: startup.startBeeBlockchain,
            },
            {
              code: "bee-nodes",
              enabled: isServiceEnabled("bee"),
              dependencies: ["bee-blockchain"],
              onFailure: "stop",
              startupCallback: startup.startBeeNodes,
            },
            {
              code: "shkeeper",
              enabled: isShkeeperEnabled(),
              onFailure: "stop",
              beforeStartup: options.portless
                ? async () => {
                  await recordPortlessAlias(
                    "shkeeper",
                    getEnv("shkeeper", serviceCtx).port,
                  )
                }
                : undefined,
              startupCallback: startup.startShkeeper,
            },
            {
              code: "mongo",
              enabled: isServiceEnabled("mongo"),
              onFailure: "stop",
              startupCallback: startup.startMongo,
            },
            {
              code: "sso",
              enabled: isServiceEnabled("sso"),
              dependencies: ["mongo"],
              onFailure: "stop",
              beforeStartup:
                options.portless && envs
                  ? async () => {
                    await recordPortlessAlias(
                      "sso",
                      parsePortFromAspNetCoreUrls(String(envs["etherna-sso"].ASPNETCORE_URLS)),
                    )
                  }
                  : undefined,
              startupCallback: startup.startSso,
            },
            {
              code: "index",
              enabled: isServiceEnabled("index"),
              dependencies: ["mongo"],
              onFailure: "stop",
              beforeStartup:
                options.portless && envs
                  ? async () => {
                    await recordPortlessAlias(
                      "index",
                      parsePortFromAspNetCoreUrls(String(envs["etherna-index"].ASPNETCORE_URLS)),
                    )
                  }
                  : undefined,
              startupCallback: startup.startIndex,
            },
            {
              code: "beehive",
              enabled: isServiceEnabled("beehive"),
              dependencies: ["mongo"],
              onFailure: "stop",
              beforeStartup:
                options.portless && envs
                  ? async () => {
                    await recordPortlessAlias(
                      "beehive",
                      parsePortFromAspNetCoreUrls(
                        String(envs["etherna-beehive"].ASPNETCORE_URLS),
                      ),
                    )
                  }
                  : undefined,
              startupCallback: startup.startBeehive,
            },
            {
              code: "gateway",
              enabled: isServiceEnabled("gateway"),
              dependencies: ["mongo", "sso"],
              onFailure: "stop",
              beforeStartup:
                options.portless && envs
                  ? async () => {
                    await recordPortlessAlias(
                      "gateway",
                      parsePortFromAspNetCoreUrls(
                        String(envs["etherna-gateway"].ASPNETCORE_URLS),
                      ),
                    )
                  }
                  : undefined,
              startupCallback: startup.startGateway,
            },
            {
              code: "credit",
              enabled: isServiceEnabled("credit"),
              dependencies: ["mongo", "sso", "shkeeper"],
              onFailure: "stop",
              beforeStartup:
                options.portless && envs
                  ? async () => {
                    await recordPortlessAlias(
                      "credit",
                      parsePortFromAspNetCoreUrls(String(envs["etherna-credit"].ASPNETCORE_URLS)),
                    )
                  }
                  : undefined,
              startupCallback: startup.startCredit,
            },
            {
              code: "elastic",
              enabled: isServiceEnabled("elastic"),
              onFailure: "stop",
              startupCallback: startup.startElastic,
            },
          ],
          { logError },
        )
        const result = await tree.start()
        if (result.shouldStop && !isShutdownRequested()) {
          await stopEnabledEthernaContainers({
            elastic: isServiceEnabled("elastic"),
            mongo: isServiceEnabled("mongo"),
            bee: isServiceEnabled("bee"),
            sso: isServiceEnabled("sso"),
            index: isServiceEnabled("index"),
            gateway: isServiceEnabled("gateway"),
            credit: isServiceEnabled("credit"),
            beehive: isServiceEnabled("beehive"),
            shkeeper: isShkeeperEnabled(),
          })
          await shutdownServices(false, false, { killTrackedSpawns: true })
        }
      })

      // Stop containers when dev server is closed
      server.httpServer?.once("close", async () => {
        await shutdownServices(false)
      })
    },
  }
}

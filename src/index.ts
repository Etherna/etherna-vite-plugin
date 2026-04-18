import chalk from "chalk"

import { assertValidGithubRepo } from "./builder"
import {
  applyEthernaPluginHttpsFallback,
  getDevServerPort,
  harnessEthernaPlugin,
  type DockerPluginOptions,
} from "./plugin-define"
import {
  ensureDockerReady,
  startAspContainer,
  startBeeNodes,
  startBlockchain,
  startElasticContainer,
  startMongoDbContainer,
  startShkeeperStack,
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
} from "./portless"
import { generateSslCertificate } from "./ssl"
import { fetchFirstShkeeperWalletApiKey } from "./utils"

import type { ServiceEnvBuildContext } from "./envs"
import type { PortlessServiceAlias } from "./portless"
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
  getDevServerPort,
  harnessEthernaPlugin,
} from "./plugin-define"

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
    isShutdownRequested,
    pushSpawn,
    setPortlessProxyStartedByUs,
    recordPortlessAliases,
    cleanupPortless,
    shutdownServices,
  } = harness

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
          ...(options.portless && portlessAppPublicUrl ? { portlessAppPublicUrl } : {}),
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
            setPortlessProxyStartedByUs(startedByUs)
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
            recordPortlessAliases(aliasEntries.map((e) => e.name))
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
              pushSpawn(p)
              if (isShutdownRequested()) {
                return [] as ChildProcess[]
              }
              return startBeeNodes(serviceCtx, getServiceEnv("bee"))
            })
            .then((procs) => {
              if (isShutdownRequested()) {
                return
              }
              pushSpawn(...procs)
            })
            .catch((error: unknown) => {
              if (!isShutdownRequested()) {
                throw error
              }
            })
        }
        if (isShkeeperEnabled()) {
          const sk = getShkeeperConfig()
          const ethRepo = sk.ethereum?.githubRepo?.trim()
          if (ethRepo) {
            assertValidGithubRepo(ethRepo)
          }
          void startShkeeperStack({
            context: serviceCtx,
            build: getShkeeperBuild(),
            coreEnv: sk.env,
            ethereumEnv: sk.ethereum?.env,
            ethereumGithubRepo: ethRepo || undefined,
            ethereumGithubBranch: sk.ethereum?.githubBranch?.trim() || undefined,
          })
            .then((procs) => pushSpawn(...procs))
            .catch((error: unknown) => {
              if (!isShutdownRequested()) {
                throw error
              }
            })
        }
        if (isServiceEnabled("elastic")) {
          void startElasticContainer(getServiceEnv("elastic"), serviceCtx).then((p) => pushSpawn(p))
        }
        if (isServiceEnabled("mongo")) {
          pushSpawn(await startMongoDbContainer(getServiceEnv("mongo"), serviceCtx))
        }
        if (isServiceEnabled("beehive")) {
          void startAspContainer(
            "etherna-beehive-manager",
            "etherna/beehive-manager:latest",
            serviceCtx,
            getServiceEnv("beehive"),
          ).then((p) => pushSpawn(p))
        }
        if (isServiceEnabled("index")) {
          void startAspContainer(
            "etherna-index",
            "etherna/etherna-index:latest",
            serviceCtx,
            getServiceEnv("index"),
          ).then((p) => pushSpawn(p))
        }
        if (isServiceEnabled("sso")) {
          pushSpawn(
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
          ).then((p) => pushSpawn(p))
        }
        if (isServiceEnabled("credit")) {
          void (async () => {
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
            )
            pushSpawn(p)
          })().catch((error: unknown) => {
            if (!isShutdownRequested()) {
              throw error
            }
          })
        }
      })

      // Stop containers when dev server is closed
      server.httpServer?.once("close", async () => {
        await shutdownServices(false)
      })
    },
  }
}

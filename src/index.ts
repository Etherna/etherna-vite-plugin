import chalk from "chalk"

import {
  ensureDockerReady,
  startAspContainer,
  startBeeNodes,
  startBlockchain,
  startElasticContainer,
  startMongoDbContainer,
} from "./docker"
import {
  type BeeEnv,
  type BeehiveEnv,
  type CreditEnv,
  type ElasticEnv,
  type GatewayEnv,
  type IndexEnv,
  type MongoEnv,
  type SsoEnv,
  getEnv,
} from "./envs"

export type {
  AspServiceEnv,
  BeeEnv,
  BeehiveEnv,
  CreditEnv,
  ElasticEnv,
  GatewayEnv,
  IndexEnv,
  MongoEnv,
  SsoEnv,
} from "./envs"
import { generateSslCertificate } from "./ssl"

import type { ChildProcess } from "node:child_process"
import type { Plugin, ServerOptions } from "vite"

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
  elastic?: boolean | ServiceConfig<ElasticEnv>
  mongo?: boolean | ServiceConfig<MongoEnv>
  bee?: boolean | ServiceConfig<BeeEnv>
  sso?: boolean | ServiceConfig<SsoEnv>
  index?: boolean | ServiceConfig<IndexEnv>
  gateway?: boolean | ServiceConfig<GatewayEnv>
  credit?: boolean | ServiceConfig<CreditEnv>
  beehive?: boolean | ServiceConfig<BeehiveEnv>
}

export function etherna(options: DockerPluginOptions = {}): Plugin {
  const spawns = [] as ChildProcess[]

  if (options.https) {
    options.https = false
    console.log(chalk.yellow(`  HTTPS not supported yet. Falling back to HTTP.`))
  }

  // kill all spawned containers on process exit
  const killSpawns = () => {
    for (const proc of spawns) {
      proc.kill()
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

  process.once("SIGINT", () => {
    process.stdin.resume()
    killSpawns()
    process.exit(0)
  })
  process.once("SIGTERM", () => {
    killSpawns()
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
      config.server.port ??= getEnv("app", options.https ? "https" : "http").port
    },
    async configureServer(server) {
      // Early return when running in isolated mode or disabled
      if (options.enabled === false) {
        console.log(chalk.yellow(`  Services disabled. Skipping container startup.`))
        return
      }

      await ensureDockerReady()

      const mode = options.https ? "https" : "http"
      // Start container once dev server is listening
      server.httpServer?.once("listening", async () => {
        if (isServiceEnabled("bee")) {
          void startBlockchain(mode, getServiceEnv("bee"))
            .then((p) => {
              spawns.push(p)
              return startBeeNodes(mode, getServiceEnv("bee"))
            })
            .then((procs) => {
              spawns.push(...procs)
            })
        }
        if (isServiceEnabled("elastic")) {
          void startElasticContainer(getServiceEnv("elastic")).then((p) => spawns.push(p))
        }
        if (isServiceEnabled("mongo")) {
          spawns.push(await startMongoDbContainer(getServiceEnv("mongo")))
        }
        if (isServiceEnabled("beehive")) {
          void startAspContainer(
            "etherna-beehive-manager",
            "etherna/beehive-manager:latest",
            mode,
            getServiceEnv("beehive"),
          ).then((p) => spawns.push(p))
        }
        if (isServiceEnabled("index")) {
          void startAspContainer(
            "etherna-index",
            "etherna/etherna-index:latest",
            mode,
            getServiceEnv("index"),
          ).then((p) => spawns.push(p))
        }
        if (isServiceEnabled("sso")) {
          spawns.push(
            await startAspContainer(
              "etherna-sso",
              "etherna/etherna-sso:latest",
              mode,
              getServiceEnv("sso"),
            ),
          )
        }
        if (isServiceEnabled("gateway")) {
          void startAspContainer(
            "etherna-gateway",
            "etherna/etherna-gateway:latest",
            mode,
            getServiceEnv("gateway"),
          ).then((p) => spawns.push(p))
        }
        if (isServiceEnabled("credit")) {
          void startAspContainer(
            "etherna-credit",
            "etherna/etherna-credit:latest",
            mode,
            getServiceEnv("credit"),
          ).then((p) => spawns.push(p))
        }
      })

      // Stop containers when dev server is closed
      server.httpServer?.once("close", () => {
        killSpawns()
      })
    },
  }
}

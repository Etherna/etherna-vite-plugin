import chalk from "chalk"

import {
  startAspContainer,
  startBeeNodes,
  startBlockchain,
  startElasticContainer,
  startMongoDbContainer,
} from "./docker"
import { getEnv } from "./envs"
import { generateSslCertificate } from "./ssl"

import type { ChildProcess } from "node:child_process"
import type { Plugin, ServerOptions } from "vite"

interface ServiceOptions {
  enabled?: boolean
  env?: Record<string, string>
}

interface DockerPluginOptions {
  https?: boolean
  enabled?: boolean
  elastic?: boolean | ServiceOptions
  mongo?: boolean | ServiceOptions
  bee?: boolean | ServiceOptions
  sso?: boolean | ServiceOptions
  index?: boolean | ServiceOptions
  gateway?: boolean | ServiceOptions
  credit?: boolean | ServiceOptions
  beehive?: boolean | ServiceOptions
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

  const isServiceEnabled = (service: keyof DockerPluginOptions) => {
    return typeof options[service] === "object"
      ? options[service]?.enabled !== false
      : options[service] !== false
  }

  const getServiceEnv = (service: keyof DockerPluginOptions) => {
    return typeof options[service] === "object" ? options[service]?.env : {}
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
    configureServer(server) {
      // Early return when running in isolated mode or disabled
      if (options.enabled === false) {
        console.log(chalk.yellow(`  Services disabled. Skipping container startup.`))
        return
      }

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

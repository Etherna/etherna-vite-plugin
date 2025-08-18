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

interface DockerPluginOptions {
  https?: boolean
  elastic?: boolean
  mongo?: boolean
  bee?: boolean
  sso?: boolean
  index?: boolean
  gateway?: boolean
  credit?: boolean
  beehive?: boolean
  validator?: boolean
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
      const mode = options.https ? "https" : "http"
      // Start container once dev server is listening
      server.httpServer?.once("listening", async () => {
        if (options.bee !== false) {
          void startBlockchain(mode)
            .then((p) => {
              spawns.push(p)
              return startBeeNodes(mode)
            })
            .then((procs) => {
              spawns.push(...procs)
            })
        }
        if (options.elastic !== false) {
          void startElasticContainer().then((p) => spawns.push(p))
        }
        if (options.mongo !== false) {
          spawns.push(await startMongoDbContainer())
        }
        if (options.beehive !== false) {
          void startAspContainer(
            "etherna-beehive-manager",
            "etherna/beehive-manager:latest",
            mode,
          ).then((p) => spawns.push(p))
        }
        if (options.index !== false) {
          void startAspContainer("etherna-index", "etherna/etherna-index:latest", mode).then((p) =>
            spawns.push(p),
          )
        }
        if (options.sso !== false) {
          spawns.push(await startAspContainer("etherna-sso", "etherna/etherna-sso:latest", mode))
        }
        if (options.gateway !== false) {
          void startAspContainer(
            "etherna-gateway-dashboard",
            "etherna/etherna-gateway-dashboard:latest",
            mode,
          ).then((p) => spawns.push(p))
        }
        if (options.validator !== false) {
          void startAspContainer(
            "etherna-gateway-validator",
            "etherna/etherna-gateway-validator:latest",
            mode,
          ).then((p) => spawns.push(p))
        }
        if (options.credit !== false) {
          void startAspContainer("etherna-credit", "etherna/etherna-credit:latest", mode).then(
            (p) => spawns.push(p),
          )
        }
      })

      // Stop containers when dev server is closed
      server.httpServer?.once("close", () => {
        killSpawns()
      })
    },
  }
}

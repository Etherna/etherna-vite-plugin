import { start } from "@etherna/docker"
import chalk from "chalk"
import { loadEnv } from "vite"

import { DEFAULT_APP_HTTPS_PORT, DEFAULT_APP_PORT } from "./consts"
import { getDevServerPort } from "./options"
import { generateSslCertificate } from "./ssl"

import type { EthernaPluginOptions } from "./options"
import type { EthernaSessionHandle, StartOptions } from "@etherna/docker"
import type { Plugin, ServerOptions } from "vite"

export type { EthernaPluginOptions } from "./options"
export { applyEthernaPluginHttpsFallback, defineEthernaPlugin, getDevServerPort } from "./options"

/** Prefixes loaded from `.env` files into `process.env` by the plugin's `config` hook. */
const ETHERNA_ENV_PREFIXES: string[] = ["ETHERNA_", "PORTLESS_"]

/**
 * Vite plugin that starts the Etherna Docker services once the dev server is listening and stops
 * them on close. All orchestration lives in `@etherna/docker`; this plugin only wires Vite-specific
 * concerns: env-prefix loading, SSL cert injection, and the `enabled` / `https` options.
 */
export function etherna(options: EthernaPluginOptions = {}): Plugin {
  let shutdown: EthernaSessionHandle["shutdown"] | undefined

  return {
    name: "etherna:vite-plugin",
    apply: "serve",
    config(userConfig, { mode }) {
      // Vite doesn't auto-populate `process.env` from `.env` files (those are loaded into
      // client-side `import.meta.env` and filtered by `envPrefix`). The Etherna services run in
      // Node and only read a small, well-known set of variables, so we restrict the merge to those
      // prefixes — keeping the user's other secrets out of `process.env`.
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
      config.server.port ??= options.https ? DEFAULT_APP_HTTPS_PORT : DEFAULT_APP_PORT
    },
    configureServer(server) {
      if (options.enabled === false) {
        console.log(chalk.yellow(`  Services disabled. Skipping container startup.`))
        return
      }

      const mode: "http" | "https" = options.https ? "https" : "http"
      const fallbackPort = options.https ? DEFAULT_APP_HTTPS_PORT : DEFAULT_APP_PORT

      // Start services once the dev server is listening (so the real port is known).
      server.httpServer?.once("listening", async () => {
        const appPort = getDevServerPort(server, fallbackPort)

        const startOpts: StartOptions = { ...options }
        delete (startOpts as EthernaPluginOptions).https
        delete (startOpts as EthernaPluginOptions).enabled

        const session = await start({
          ...startOpts,
          appPort,
          mode,
          installSignalHandlers: true,
        })
        shutdown = session.shutdown
      })

      // Stop services when the dev server closes.
      server.httpServer?.once("close", async () => {
        await shutdown?.()
      })
    },
  }
}

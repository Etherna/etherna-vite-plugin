import chalk from "chalk"

import type { StartOptions } from "@etherna/docker"

/**
 * Options accepted by the {@link etherna} Vite plugin: the full docker `StartOptions` surface plus
 * two Vite-only fields.
 */
export type EthernaPluginOptions = StartOptions & {
  /** When `false`, the plugin skips all container startup (useful for isolated front-end runs). */
  enabled?: boolean
  /** When `true`, injects a self-signed certificate into the Vite dev/preview server and runs services in HTTPS mode. */
  https?: boolean
}

/**
 * The slice of a Vite dev server `getDevServerPort` reads.
 * Structural on purpose: the published signature must not name Vite's `ViteDevServer`, which
 * recurses through `UserConfig` and breaks `defineConfig` when a linked install resolves a second
 * copy of Vite.
 */
interface DevServerPortSource {
  httpServer?: {
    address(): string | { port?: number } | null
  } | null
}

/** Reads the actual listening port from the dev server, falling back to `fallbackPort` when unavailable. */
export function getDevServerPort(server: DevServerPortSource, fallbackPort: number): number {
  const addr = server.httpServer?.address()
  if (addr && typeof addr === "object" && "port" in addr && typeof addr.port === "number") {
    return addr.port
  }
  return fallbackPort
}

/** Typed options helper (similar to `defineConfig` in Vite). */
export function defineEthernaPlugin(options: EthernaPluginOptions): EthernaPluginOptions {
  return options
}

/** Disables HTTPS and logs once. Mutates `options`. */
export function applyEthernaPluginHttpsFallback(options: EthernaPluginOptions): void {
  if (options.https) {
    options.https = false
    console.log(chalk.yellow(`  HTTPS not supported yet. Falling back to HTTP.`))
  }
}

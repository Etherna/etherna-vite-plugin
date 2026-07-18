import type { Plugin } from "vite"

export function etherna(_options: Record<string, unknown> = {}): Plugin {
  return { name: "etherna:vite-plugin", apply: "serve" }
}

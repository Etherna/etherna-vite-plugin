import { defineConfig } from "tsup"

const shared = {
  splitting: false,
  sourcemap: true,
  minify: true,
  dts: true,
  external: ["vite", "@etherna/docker"],
}

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    clean: true,
    format: ["esm", "cjs"],
  },
])

import { defineConfig } from "tsup"

const shared = {
  splitting: false,
  sourcemap: true,
  minify: true,
  dts: true,
  external: ["vite"],
}

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    clean: true,
    format: ["esm", "cjs"],
  },
  {
    ...shared,
    entry: ["src/bin.ts"],
    clean: false,
    format: ["cjs"],
    dts: false,
  },
])

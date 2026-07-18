import { defineConfig } from "tsdown"

const shared = {
  sourcemap: true,
  minify: true,
  dts: true,
  deps: {
    onlyBundle: false as const,
  },
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

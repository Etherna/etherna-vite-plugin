import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts"],
  clean: true,
  format: ["esm", "cjs"],
  sourcemap: true,
  minify: true,
  dts: true,
  deps: {
    neverBundle: ["vite", "@etherna/docker"],
    onlyBundle: false,
  },
})

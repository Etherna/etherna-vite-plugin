import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const dockerSourceEntry = fileURLToPath(new URL("../docker/src/index.ts", import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Package exports point at dist/, which does not exist until build. CI runs tests first.
      "@etherna/docker": dockerSourceEntry,
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})

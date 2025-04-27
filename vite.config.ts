import { defineConfig } from "vite"

import { etherna } from "./src"

export default defineConfig({
  plugins: [
    etherna({
      mongo: true,
      bee: true,
      sso: true,
      index: true,
      gateway: true,
      credit: true,
      beehiveManager: true,
    }),
  ],
})

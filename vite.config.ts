import { defineConfig } from "vite"

import { etherna } from "./src"

export default defineConfig({
  server: {
    port: 5174,
  },
  plugins: [
    etherna({
      mongo: false,
      elastic: true,
      bee: false,
      beehiveManager: false,
      sso: false,
      credit: false,
      index: false,
      gateway: false,
      interceptor: false,
    }),
  ],
})

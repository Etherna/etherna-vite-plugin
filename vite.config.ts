import { defineConfig } from "vite"

import { etherna } from "./src"

export default defineConfig({
  server: {
    port: 5174,
  },
  plugins: [
    etherna({
      // mongo: true,
      // elastic: true,
      // bee: true,
      // beehiveManager: true,
      // sso: true,
      // credit: true,
      // index: true,
      // gateway: true,
      // interceptor: true,
    }),
  ],
})

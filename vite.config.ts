import { defineConfig } from "vite"

import { etherna } from "./src"

export default defineConfig({
  server: {
    port: 5174,
  },
  plugins: [
    etherna({
      mongo: true,
      elastic: false,
      bee: false,
      beehive: false,
      sso: false,
      credit: false,
      index: false,
      gateway: false,
    }),
  ],
})

import { defineConfig } from "vite"

import { etherna } from "./src"

export default defineConfig({
  server: {
    port: 5174,
  },
  plugins: [
    etherna({
      portless: true,
      mongo: true,
      elastic: false,
      bee: true,
      beehive: false,
      sso: true,
      credit: true,
      index: false,
      gateway: false,
      shkeeper: {
        ethereum: {
          githubRepo: "mattiaz9/ethereum-shkeeper",
        },
      },
    }),
  ],
})

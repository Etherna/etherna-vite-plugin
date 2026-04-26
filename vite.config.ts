import { defineConfig } from "vite"

import { etherna } from "./src"

export default defineConfig({
  server: {
    port: 5174,
  },
  plugins: [
    etherna({
      // settings
      detached: true,
      // services
      portless: true,
      mongo: true,
      elastic: false,
      bee: true,
      beehive: true,
      sso: true,
      credit: true,
      index: true,
      gateway: true,
      shkeeper: false,
      // shkeeper: {
      //   ethereum: {
      //     githubRepo: "mattiaz9/ethereum-shkeeper",
      //   },
      // },
    }),
  ],
})

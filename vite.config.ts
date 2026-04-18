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
      bee: false,
      beehive: false,
      sso: true,
      credit: true,
      index: false,
      gateway: false,
      shkeeper: false,
      // shkeeper: {
      //   ethereum: {
      //     githubRepo: "mattiaz9/ethereum-shkeeper",
      //   },
      // },
    }),
  ],
})

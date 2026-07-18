import { etherna } from "@etherna/vite-plugin"
import { defineConfig } from "vite"

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

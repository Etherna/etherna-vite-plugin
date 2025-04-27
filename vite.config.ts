import { defineConfig } from "vite"

import { etherna } from "./src"

export default defineConfig({
  plugins: [etherna()],
})

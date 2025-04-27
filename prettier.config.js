// @ts-check

/** @type {import('prettier').Config & import('@ianvs/prettier-plugin-sort-imports').PluginConfig} */
export default {
  semi: false,
  arrowParens: "always",
  trailingComma: "all",
  printWidth: 100,
  importOrder: [
    "<THIRD_PARTY_MODULES>",
    "",
    "^[./]",
    "^@/",
    "",
    "<TYPES>^[./]",
    "<TYPES>^@/",
    "<TYPES>",
  ],
  importOrderTypeScriptVersion: "5.0.0",
  tailwindConfig: "./tailwind.config.ts",
  plugins: ["@ianvs/prettier-plugin-sort-imports"],
}

#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const tag = process.argv[2] || process.env.GITHUB_REF_NAME
if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error(`Invalid or missing tag: ${tag}`)
  process.exit(1)
}
const expected = tag.slice(1)

const docker = JSON.parse(readFileSync(resolve("packages/docker/package.json"), "utf8"))
const vite = JSON.parse(readFileSync(resolve("packages/vite-plugin/package.json"), "utf8"))

if (docker.version !== expected || vite.version !== expected || docker.version !== vite.version) {
  console.error(
    `Version mismatch: tag=${tag} docker=${docker.version} vite-plugin=${vite.version}`,
  )
  process.exit(1)
}
console.log(`OK: ${tag} matches both packages @ ${expected}`)

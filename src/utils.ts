import { spawn } from "node:child_process"
import path from "node:path"
import chalk from "chalk"

import { DEFAULT_CACHE_DIR } from "./consts"

import type { SpawnOptionsWithoutStdio } from "node:child_process"

export function resolvePath(...paths: string[]) {
  return path.resolve(DEFAULT_CACHE_DIR, ...paths)
}

export function resolvePathEscape(...paths: string[]) {
  return resolvePath(...paths).replace(/:/g, "/")
}

export function logSuccess(containerName: string, protocol: string, port: string) {
  const url = `${protocol}://localhost:${chalk.bold.cyanBright(port)}/`
  console.log(`  ${chalk.green("➜")}  ${chalk.bold(containerName)}:   ${chalk.cyan(url)}`)
}

export function logLoading(containerName: string) {
  console.log(
    `  ${chalk.gray("➜")}  ${chalk.bold(containerName)}:   ${chalk.yellow("Downloading image...")}`,
  )
}

export function logError(containerName: string, reason: string) {
  console.log(`  ${chalk.red("x")}  ${chalk.bold(containerName)}:   ${chalk.red(reason)}`)
}

export async function runCommand(cmd: string, args?: string[], options?: SpawnOptionsWithoutStdio) {
  const proc = spawn(cmd, args, options)

  return new Promise<void>((res, rej) => {
    proc.on("error", (err) => {
      rej(err)
    })
    proc.on("exit", () => {
      res()
    })
  })
}

export async function getBeeUnderlayAddress(url: string) {
  const resp = await fetch(`${url}/addresses`)
  if (!resp.ok) {
    throw new Error(`Failed to fetch addresses from ${url}: ${resp.statusText}`)
  }
  const data = (await resp.json()) as {
    underlay: string[] | undefined
  }
  const underlay = Array.isArray(data.underlay) ? data.underlay : []

  if (underlay.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    return getBeeUnderlayAddress(url)
  }

  const address = underlay.find((url) => !url.includes("127.0.0.1"))

  if (!address) {
    throw new Error(`No valid underlay address found in response from ${url}`)
  }
  return address
}

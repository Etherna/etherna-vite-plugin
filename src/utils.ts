import { spawn } from "node:child_process"
import { resolve } from "node:path"
import chalk from "chalk"

import type { SpawnOptionsWithoutStdio } from "node:child_process"

export function resolvePath(...paths: string[]) {
  return resolve(import.meta.dirname, ...paths).replace(/:/g, "/")
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

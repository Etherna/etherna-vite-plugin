import { spawn } from "node:child_process"
import path from "node:path"

import { DEFAULT_CACHE_DIR } from "./consts"

import type { SpawnOptionsWithoutStdio } from "node:child_process"

export function resolvePath(...paths: string[]): string {
  return path.resolve(DEFAULT_CACHE_DIR, ...paths)
}

/** Runs a command to completion, resolving on exit and rejecting on spawn error. */
export async function runCommand(
  cmd: string,
  args?: string[],
  options?: SpawnOptionsWithoutStdio,
): Promise<void> {
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

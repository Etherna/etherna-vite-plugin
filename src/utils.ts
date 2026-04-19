import { spawn } from "node:child_process"
import path from "node:path"
import chalk from "chalk"

import { DEFAULT_CACHE_DIR } from "./consts"

import type { SpawnOptionsWithoutStdio } from "node:child_process"

/** ShKeeper core container name (see `startShkeeperCoreContainer` in docker.ts). */
const SHKEEPER_CORE_CONTAINER_NAME = "shkeeper"

/** SQLite DB path inside the ShKeeper core container. */
const SHKEEPER_INSTANCE_SQLITE_PATH = "/shkeeper.io/instance/shkeeper.sqlite"

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export interface FetchFirstShkeeperWalletApiKeyOptions {
  /** Docker container running ShKeeper core (default: `shkeeper`). */
  containerName?: string
  /** Path to `shkeeper.sqlite` inside that container. */
  sqlitePath?: string
  /** Max polling attempts when the DB or row is not ready yet (default: 120). */
  maxAttempts?: number
  /** Delay between attempts in ms (default: 1000). */
  intervalMs?: number
}

/**
 * Reads the first non-empty `apikey` from ShKeeper's instance SQLite (`wallet` table).
 * Uses `docker exec` + `sqlite3` in the running core container — no extra npm deps.
 * Polls until a row exists or attempts are exhausted (ShKeeper may populate the DB after startup).
 */
export async function fetchFirstShkeeperWalletApiKey(
  options?: FetchFirstShkeeperWalletApiKeyOptions,
): Promise<string | null> {
  const containerName = options?.containerName ?? SHKEEPER_CORE_CONTAINER_NAME
  const sqlitePath = options?.sqlitePath ?? SHKEEPER_INSTANCE_SQLITE_PATH
  const maxAttempts = options?.maxAttempts ?? 120
  const intervalMs = options?.intervalMs ?? 1000

  const sql =
    "SELECT apikey FROM wallet WHERE apikey IS NOT NULL AND TRIM(COALESCE(apikey, '')) != '' LIMIT 1"

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const value = await runDockerSqliteScalar(containerName, sqlitePath, sql)
    if (value) {
      return value
    }
    if (attempt < maxAttempts - 1) {
      await sleep(intervalMs)
    }
  }

  return null
}

function runDockerSqliteScalar(
  containerName: string,
  sqlitePath: string,
  sql: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["exec", containerName, "sqlite3", sqlitePath, sql])

    let stdout = ""
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    })
    proc.on("error", () => {
      resolve(null)
    })
    proc.on("close", (code: number | null) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const trimmed = stdout.trim()
      resolve(trimmed.length > 0 ? trimmed : null)
    })
  })
}

/**
 * Reads an env variable from both `process.env` and `import.meta.env`.
 *
 * `process.env` takes precedence (shell-set vars and CI environments win over
 * Vite's `.env` files). The `etherna` plugin's `config` hook already merges
 * `.env` values into `process.env` via Vite's `loadEnv`, so the
 * `import.meta.env` branch is mainly a safety net for callers that import
 * helpers from this package outside of the plugin's lifecycle.
 */
export function getEnvVar(key: string): string | undefined {
  const fromProcess = typeof process !== "undefined" ? process.env?.[key] : undefined
  if (fromProcess !== undefined) {
    return fromProcess
  }

  try {
    const meta = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env
    const value = meta?.[key]
    return typeof value === "string" ? value : undefined
  } catch {
    return undefined
  }
}

export function resolvePath(...paths: string[]) {
  return path.resolve(DEFAULT_CACHE_DIR, ...paths)
}

export function resolvePathEscape(...paths: string[]) {
  const resolved = resolvePath(...paths)
  if (process.platform === "win32") {
    return resolved.replace(/\\/g, "/")
  }
  return resolved
}

export function logSuccess(
  containerName: string,
  protocol: string,
  port: string,
  options?: { portlessUrl?: string },
) {
  if (options?.portlessUrl) {
    const friendly = `${options.portlessUrl.replace(/\/$/, "")}/`
    const raw = `${protocol}://localhost:${port}/`
    console.log(
      `  ${chalk.green("➜")}  ${chalk.bold(containerName)}:   ${chalk.cyan(friendly)} ${chalk.gray(`(${raw})`)}`,
    )
    return
  }
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

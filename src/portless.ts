import { spawn } from "node:child_process"

/** HTTP proxy port used by Portless when running without TLS (see portless docs). */
export const PORTLESS_PROXY_PORT = 1355

/** Alias names registered with `portless alias <name> <port>`. */
export type PortlessServiceAlias =
  | "app"
  | "sso"
  | "index"
  | "credit"
  | "gateway"
  | "beehive"
  | "bee"

export const PORTLESS_CONTAINER_ALIASES: Record<string, PortlessServiceAlias> = {
  "etherna-sso": "sso",
  "etherna-index": "index",
  "etherna-credit": "credit",
  "etherna-gateway": "gateway",
  "etherna-beehive-manager": "beehive",
}

export function getPortlessPublicUrl(alias: PortlessServiceAlias): string {
  return `http://${alias}.localhost:${PORTLESS_PROXY_PORT}`
}

export function portlessProxyStartArgs(): string[] {
  return ["proxy", "start", "-p", String(PORTLESS_PROXY_PORT), "--no-tls"]
}

export function portlessProxyStopArgs(): string[] {
  return ["proxy", "stop"]
}

export function portlessAliasAddArgs(name: string, port: number, force = false): string[] {
  const args = ["alias", name, String(port)]
  if (force) {
    args.push("--force")
  }
  return args
}

export function portlessAliasRemoveArgs(name: string): string[] {
  return ["alias", "--remove", name]
}

export async function runPortlessCli(args: string[]): Promise<{
  code: number
  stderr: string
  stdout: string
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn("portless", args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    proc.stdout?.on("data", (d) => {
      stdout += String(d)
    })
    proc.stderr?.on("data", (d) => {
      stderr += String(d)
    })
    proc.on("error", reject)
    proc.on("exit", (code) => {
      resolve({ code: code ?? 1, stderr, stdout })
    })
  })
}

/** True when the `portless` CLI is on PATH and runs. */
export async function isPortlessCliAvailable(): Promise<boolean> {
  try {
    const r = await runPortlessCli(["--version"])
    return r.code === 0
  } catch {
    return false
  }
}

/**
 * Starts the Portless HTTP proxy on {@link PORTLESS_PROXY_PORT}. If the proxy is already
 * running, returns `startedByUs: false` without failing.
 */
export async function ensurePortlessProxy(): Promise<{ startedByUs: boolean }> {
  const r = await runPortlessCli(portlessProxyStartArgs())
  if (r.code === 0) {
    return { startedByUs: true }
  }
  const combined = `${r.stderr}\n${r.stdout}`
  if (/already|in use|running|listen/i.test(combined)) {
    return { startedByUs: false }
  }
  throw new Error(
    `portless proxy start failed (exit ${r.code}): ${combined.trim() || "(no output)"}`,
  )
}

export async function registerPortlessAliases(
  entries: ReadonlyArray<{ name: PortlessServiceAlias; port: number }>,
): Promise<void> {
  for (const { name, port } of entries) {
    const r = await runPortlessCli(portlessAliasAddArgs(name, port, true))
    if (r.code !== 0) {
      const combined = `${r.stderr}\n${r.stdout}`
      throw new Error(`portless alias ${name} ${port} failed: ${combined.trim()}`)
    }
  }
}

export async function removePortlessAliases(names: readonly PortlessServiceAlias[]): Promise<void> {
  for (const name of names) {
    await runPortlessCli(portlessAliasRemoveArgs(name))
  }
}

export async function stopPortlessProxy(): Promise<void> {
  await runPortlessCli(portlessProxyStopArgs())
}

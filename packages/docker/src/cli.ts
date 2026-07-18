import chalk from "chalk"

import { resolveEnabledFromServices } from "./catalog"
import { start, stop } from "./manager"

import type { EthernaServiceName, StartOptions } from "./types"

export type CliCommand = "start" | "stop" | "help"
export type CliServiceName = "all" | EthernaServiceName

export interface CliStartOptions {
  appPort?: number
  detached?: boolean
  portless?: boolean
}

export interface ParsedCliArgs {
  command: CliCommand
  services: CliServiceName[]
  options: CliStartOptions
}

/** Every logical service name, mirroring `EthernaServiceName` (kept as a runtime array for CLI parsing/expansion). */
const ALL_SERVICE_NAMES: readonly EthernaServiceName[] = [
  "blockchain",
  "bee",
  "beehive",
  "credit",
  "elastic",
  "gateway",
  "index",
  "mongo",
  "shkeeper",
  "sso",
]

function isCliServiceName(value: string): value is CliServiceName {
  return value === "all" || (ALL_SERVICE_NAMES as readonly string[]).includes(value)
}

/** Expands the `"all"` keyword (or an empty selection) into every logical service name. */
function expandServiceNames(services: CliServiceName[]): EthernaServiceName[] {
  if (services.length === 0 || services.includes("all")) {
    return [...ALL_SERVICE_NAMES]
  }
  return services as EthernaServiceName[]
}

function parsePort(raw: string | undefined, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${flag} expects a TCP port between 1 and 65535.`)
  }
  return value
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const [commandRaw, ...rest] = argv
  const command =
    commandRaw === undefined || commandRaw === "help" || commandRaw === "--help"
      ? "help"
      : commandRaw

  if (command !== "start" && command !== "stop" && command !== "help") {
    throw new Error(`Unknown command "${commandRaw}".`)
  }

  const services: CliServiceName[] = []
  const options: CliStartOptions = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string
    if (arg === "--portless") {
      options.portless = true
      continue
    }
    if (arg === "--no-portless") {
      options.portless = false
      continue
    }
    if (arg === "--detached") {
      options.detached = true
      continue
    }
    if (arg === "--attached") {
      options.detached = false
      continue
    }
    if (arg === "--app-port") {
      i += 1
      options.appPort = parsePort(rest[i], "--app-port")
      continue
    }
    if (arg.startsWith("--app-port=")) {
      options.appPort = parsePort(arg.slice("--app-port=".length), "--app-port")
      continue
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}".`)
    }
    if (!isCliServiceName(arg)) {
      throw new Error(`Unknown service "${arg}".`)
    }
    services.push(arg)
  }

  if (command === "stop" && services.length === 0) {
    throw new Error(`The "stop" command requires at least one service.`)
  }

  return { command, services, options }
}

/**
 * Resolves a CLI service selection into the canonical enabled-service map, following the Vite
 * plugin's dependency graph ({@link resolveEnabledFromServices}) — not the legacy CLI graph. An
 * empty selection (or the `"all"` keyword) enables every logical service.
 */
export function resolveCliServiceSelection(
  services: CliServiceName[],
): Record<EthernaServiceName, boolean> {
  return resolveEnabledFromServices(expandServiceNames(services))
}

function toStartOptions(
  enabled: Record<EthernaServiceName, boolean>,
  options: CliStartOptions,
): StartOptions {
  return {
    detached: options.detached ?? true,
    portless: options.portless,
    appPort: options.appPort,
    installSignalHandlers: true,
    elastic: enabled.elastic,
    mongo: enabled.mongo,
    bee: enabled.bee,
    sso: enabled.sso,
    index: enabled.index,
    gateway: enabled.gateway,
    credit: enabled.credit,
    beehive: enabled.beehive,
    shkeeper: enabled.shkeeper,
  }
}

export function getCliHelp() {
  return `Usage:
  etherna start [services...] [options]
  etherna stop <services...>

Services:
  all, blockchain, bee, beehive, credit, elastic, gateway, index, mongo, shkeeper, sso

Options:
  --portless           Start Portless proxy and register aliases
  --no-portless        Disable Portless aliases
  --app-port <port>    App port used for SSO client URLs and the app Portless alias
  --detached           Reuse already-running containers and leave services running (default)
  --attached           Stop tracked Docker processes when the CLI exits
  --help               Show this help

Examples:
  etherna start sso gateway
  etherna start sso gateway --portless --app-port 5173
  etherna stop mongo sso`
}

export async function runCli(argv = process.argv.slice(2)) {
  try {
    const parsed = parseCliArgs(argv)

    if (parsed.command === "help") {
      console.log(getCliHelp())
      return
    }

    if (parsed.command === "stop") {
      await stop(expandServiceNames(parsed.services))
      return
    }

    const enabled = resolveCliServiceSelection(parsed.services)
    const startOptions = toStartOptions(enabled, parsed.options)
    await start(startOptions)

    // Detached: containers are left running in the background — hand control back to the shell.
    // Attached: the started containers' own child processes (plus the session's signal handlers)
    // keep this process alive until a shutdown signal is received.
    if (startOptions.detached) {
      process.exit(0)
    }
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)))
    console.error("")
    console.error(getCliHelp())
    process.exitCode = 1
  }
}

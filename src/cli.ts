import chalk from "chalk"

import { resolveShkeeperImageName } from "./builder"
import { createDependenciesTree } from "./dependencies-tree"
import {
  ensureDockerReady,
  startAspContainer,
  startBeeNodes,
  startBlockchain,
  startElasticContainer,
  startMongoDbContainer,
  startShkeeperStack,
  stopEnabledEthernaContainers,
} from "./docker"
import {
  buildServiceEnvs,
  defaultServiceEnvBuildContext,
  getEnv,
  parsePortFromAspNetCoreUrls,
} from "./envs"
import { harnessEthernaPlugin, type ServiceKey } from "./plugin-define"
import {
  ensurePortlessProxy,
  getPortlessPublicUrl,
  isPortlessCliAvailable,
  normalizePortlessAppPublicUrl,
  PORTLESS_URL_ENV,
} from "./portless"
import { fetchFirstShkeeperWalletApiKey, getEnvVar, logError } from "./utils"

import type { DependencyTreeServiceDefinition } from "./dependencies-tree"
import type { EnabledEthernaServices } from "./docker"
import type { ServiceEnvBuildContext } from "./envs"
import type { ChildProcess } from "node:child_process"

type CliCommand = "start" | "help"
type CliServiceName =
  | "all"
  | "blockchain"
  | "bee"
  | "beehive"
  | "credit"
  | "elastic"
  | "gateway"
  | "index"
  | "mongo"
  | "shkeeper"
  | "sso"
type CliStartupCode =
  | "bee-blockchain"
  | "bee-nodes"
  | Exclude<CliServiceName, "all" | "blockchain" | "bee">

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

const DEFAULT_START_SERVICES = ["all"] as const satisfies CliServiceName[]
const TOP_LEVEL_START_SERVICES = [
  "elastic",
  "mongo",
  "bee",
  "sso",
  "index",
  "gateway",
  "credit",
  "beehive",
] as const satisfies CliServiceName[]

const SERVICE_DEPENDENCIES = {
  elastic: [],
  mongo: [],
  "bee-blockchain": [],
  "bee-nodes": ["bee-blockchain"],
  beehive: ["mongo", "bee-nodes"],
  sso: ["mongo"],
  gateway: ["mongo", "sso", "beehive"],
  index: ["mongo", "sso", "gateway"],
  shkeeper: ["bee-blockchain"],
  credit: ["mongo", "sso", "shkeeper"],
} satisfies Record<CliStartupCode, CliStartupCode[]>

function isCliServiceName(value: string): value is CliServiceName {
  return (
    value === "all" ||
    value === "blockchain" ||
    value === "bee" ||
    value === "beehive" ||
    value === "credit" ||
    value === "elastic" ||
    value === "gateway" ||
    value === "index" ||
    value === "mongo" ||
    value === "shkeeper" ||
    value === "sso"
  )
}

function toStartupCode(service: CliServiceName): CliStartupCode | "all" {
  if (service === "blockchain") {
    return "bee-blockchain"
  }
  if (service === "bee") {
    return "bee-nodes"
  }
  return service
}

function resolveStartupCodes(services: CliServiceName[]): Set<CliStartupCode> {
  const selected = services.length > 0 ? services : [...DEFAULT_START_SERVICES]
  const requested = selected.includes("all")
    ? TOP_LEVEL_START_SERVICES.map(toStartupCode)
    : selected.map(toStartupCode)
  const out = new Set<CliStartupCode>()

  function visit(code: CliStartupCode | "all") {
    if (code === "all" || out.has(code)) {
      return
    }
    for (const dep of SERVICE_DEPENDENCIES[code]) {
      visit(dep)
    }
    out.add(code)
  }

  for (const code of requested) {
    visit(code)
  }
  return out
}

export function resolveCliServiceSelection(services: CliServiceName[]): EnabledEthernaServices {
  const codes = resolveStartupCodes(services)
  return {
    elastic: codes.has("elastic"),
    mongo: codes.has("mongo"),
    bee: codes.has("bee-blockchain") || codes.has("bee-nodes"),
    sso: codes.has("sso"),
    index: codes.has("index"),
    gateway: codes.has("gateway"),
    credit: codes.has("credit"),
    beehive: codes.has("beehive"),
    shkeeper: codes.has("shkeeper"),
  }
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
  if (command !== "start" && command !== "help") {
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

  return { command, services, options }
}

async function setupPortless(
  context: ServiceEnvBuildContext,
  enabled: EnabledEthernaServices,
  harness: ReturnType<typeof harnessEthernaPlugin>,
) {
  if (!(await isPortlessCliAvailable())) {
    throw new Error("portless CLI not found. Install globally: npm install -g portless")
  }

  const { startedByUs } = await ensurePortlessProxy()
  harness.setPortlessProxyStartedByUs(startedByUs)

  const envs = buildServiceEnvs(context)
  const portlessAppPublicUrl = getEnvVar(PORTLESS_URL_ENV)?.trim()
  if (!portlessAppPublicUrl) {
    await harness.recordPortlessAlias("app", context.appPort)
  }
  if (enabled.sso) {
    await harness.recordPortlessAlias(
      "sso",
      parsePortFromAspNetCoreUrls(String(envs["etherna-sso"].ASPNETCORE_URLS)),
    )
  }
  if (enabled.index) {
    await harness.recordPortlessAlias(
      "index",
      parsePortFromAspNetCoreUrls(String(envs["etherna-index"].ASPNETCORE_URLS)),
    )
  }
  if (enabled.gateway) {
    await harness.recordPortlessAlias(
      "gateway",
      parsePortFromAspNetCoreUrls(String(envs["etherna-gateway"].ASPNETCORE_URLS)),
    )
  }
  if (enabled.credit) {
    await harness.recordPortlessAlias(
      "credit",
      parsePortFromAspNetCoreUrls(String(envs["etherna-credit"].ASPNETCORE_URLS)),
    )
  }
  if (enabled.beehive) {
    await harness.recordPortlessAlias(
      "beehive",
      parsePortFromAspNetCoreUrls(String(envs["etherna-beehive"].ASPNETCORE_URLS)),
    )
  }
  if (enabled.bee) {
    const beeBase = getEnv("etherna-bee", context) ?? {}
    await harness.recordPortlessAlias("bee", beeBase.BEE_PORT ?? 1633)
  }

  const appUrl = portlessAppPublicUrl
    ? `${normalizePortlessAppPublicUrl(portlessAppPublicUrl)}/`
    : `${getPortlessPublicUrl("app")}/`
  console.log(chalk.green(`  ➜  ${chalk.bold("app (portless)")}:   ${chalk.cyan(appUrl)}`))
}

function pushSpawnMaybe(
  pushSpawn: (...procs: ChildProcess[]) => void,
  ...procs: (ChildProcess | null)[]
) {
  pushSpawn(...procs.filter((p): p is ChildProcess => p != null))
}

function createCliServiceDefinitions({
  context,
  codes,
  enabled,
  detached,
  pushSpawn,
  isShutdownRequested,
}: {
  context: ServiceEnvBuildContext
  codes: Set<CliStartupCode>
  enabled: EnabledEthernaServices
  detached: boolean
  pushSpawn: (...procs: ChildProcess[]) => void
  isShutdownRequested: () => boolean
}): DependencyTreeServiceDefinition<CliStartupCode>[] {
  const serviceEnv = <K extends ServiceKey>(_service: K) => ({})

  return [
    {
      code: "bee-blockchain",
      enabled: codes.has("bee-blockchain"),
      onFailure: "stop",
      startupCallback: async () => {
        const p = await startBlockchain(context, serviceEnv("bee"), { detached })
        pushSpawnMaybe(pushSpawn, p)
        return !isShutdownRequested()
      },
    },
    {
      code: "bee-nodes",
      enabled: codes.has("bee-nodes"),
      dependencies: ["bee-blockchain"],
      onFailure: "stop",
      startupCallback: async () => {
        const procs = await startBeeNodes(context, serviceEnv("bee"), { detached })
        pushSpawnMaybe(pushSpawn, ...procs)
        return !isShutdownRequested()
      },
    },
    {
      code: "shkeeper",
      enabled: enabled.shkeeper,
      dependencies: ["bee-blockchain"],
      onFailure: "stop",
      startupCallback: async () => {
        const procs = await startShkeeperStack({
          context,
          build: {
            githubRepo: undefined,
            githubBranch: undefined,
            imageName: resolveShkeeperImageName(),
          },
          detached,
        })
        pushSpawnMaybe(pushSpawn, ...procs)
        return !isShutdownRequested()
      },
    },
    {
      code: "mongo",
      enabled: enabled.mongo,
      onFailure: "stop",
      startupCallback: async () => {
        const p = await startMongoDbContainer(serviceEnv("mongo"), context, { detached })
        pushSpawnMaybe(pushSpawn, p)
        return !isShutdownRequested()
      },
    },
    {
      code: "sso",
      enabled: enabled.sso,
      dependencies: ["mongo"],
      onFailure: "stop",
      startupCallback: async () => {
        const p = await startAspContainer(
          "etherna-sso",
          "etherna/etherna-sso:latest",
          context,
          serviceEnv("sso"),
          { detached },
        )
        pushSpawnMaybe(pushSpawn, p)
        return !isShutdownRequested()
      },
    },
    {
      code: "beehive",
      enabled: enabled.beehive,
      dependencies: ["mongo", "bee-nodes"],
      onFailure: "stop",
      startupCallback: async () => {
        const p = await startAspContainer(
          "etherna-beehive",
          "etherna/beehive:latest",
          context,
          serviceEnv("beehive"),
          { detached },
        )
        pushSpawnMaybe(pushSpawn, p)
        return !isShutdownRequested()
      },
    },
    {
      code: "gateway",
      enabled: enabled.gateway,
      dependencies: ["mongo", "sso", "beehive"],
      onFailure: "stop",
      startupCallback: async () => {
        const p = await startAspContainer(
          "etherna-gateway",
          "etherna/etherna-gateway:latest",
          context,
          serviceEnv("gateway"),
          { detached },
        )
        pushSpawnMaybe(pushSpawn, p)
        return !isShutdownRequested()
      },
    },
    {
      code: "index",
      enabled: enabled.index,
      dependencies: ["mongo", "sso", "gateway"],
      onFailure: "stop",
      startupCallback: async () => {
        const p = await startAspContainer(
          "etherna-index",
          "etherna/etherna-index:latest",
          context,
          serviceEnv("index"),
          { detached },
        )
        pushSpawnMaybe(pushSpawn, p)
        return !isShutdownRequested()
      },
    },
    {
      code: "credit",
      enabled: enabled.credit,
      dependencies: ["mongo", "sso", "shkeeper"],
      onFailure: "stop",
      startupCallback: async () => {
        const apiKey = await fetchFirstShkeeperWalletApiKey()
        const env = apiKey ? { "Payments:ShKeeper:ApiKey": apiKey } : {}
        const p = await startAspContainer(
          "etherna-credit",
          "etherna/etherna-credit:latest",
          context,
          env,
          { detached },
        )
        pushSpawnMaybe(pushSpawn, p)
        return !isShutdownRequested()
      },
    },
    {
      code: "elastic",
      enabled: enabled.elastic,
      onFailure: "stop",
      startupCallback: async () => {
        const p = await startElasticContainer(serviceEnv("elastic"), context, { detached })
        pushSpawnMaybe(pushSpawn, p)
        return !isShutdownRequested()
      },
    },
  ]
}

export async function startCliServices(services: CliServiceName[], options: CliStartOptions = {}) {
  const codes = resolveStartupCodes(services)
  const enabled = resolveCliServiceSelection(services)
  const defaultContext = defaultServiceEnvBuildContext("http")
  const detached = options.detached ?? true
  const context: ServiceEnvBuildContext = {
    ...defaultContext,
    appPort: options.appPort ?? defaultContext.appPort,
    portless: Boolean(options.portless),
  }

  const harness = harnessEthernaPlugin({ ...enabled, detached, portless: context.portless })
  harness.installProcessSignalHandlers()

  await ensureDockerReady()
  if (context.portless) {
    await setupPortless(context, enabled, harness)
  }

  const tree = createDependenciesTree(
    createCliServiceDefinitions({
      context,
      codes,
      enabled,
      detached,
      pushSpawn: harness.pushSpawn,
      isShutdownRequested: harness.isShutdownRequested,
    }),
    { logError },
  )
  const result = await tree.start()
  if (result.shouldStop && !harness.isShutdownRequested()) {
    await stopEnabledEthernaContainers(enabled)
    await harness.shutdownServices(false, false, { killTrackedSpawns: true })
    process.exitCode = 1
  }
}

export function getCliHelp() {
  return `Usage:
  etherna start [services...] [options]

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
  etherna start sso gateway --portless --app-port 5173`
}

export async function runCli(argv = process.argv.slice(2)) {
  try {
    const parsed = parseCliArgs(argv)
    if (parsed.command === "help") {
      console.log(getCliHelp())
      return
    }
    await startCliServices(parsed.services, parsed.options)
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)))
    console.error("")
    console.error(getCliHelp())
    process.exitCode = 1
  }
}

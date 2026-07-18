import chalk from "chalk"

import { ALL_SERVICE_NAMES, SERVICE_CATALOG, type StartupCode } from "./catalog"
import { createDependencyRunner, type DependencyRunnerServiceDefinition } from "./dependency-runner"
import {
  buildServiceEnvs,
  defaultServiceEnvBuildContext,
  getEnv,
  parsePortFromAspNetCoreUrls,
  type ServiceEnvBuildContext,
} from "./env"
import {
  addPortlessAlias,
  ensurePortlessProxy,
  getPortlessPublicUrl,
  isPortlessCliAvailable,
  normalizePortlessAppPublicUrl,
  PORTLESS_URL_ENV,
  removePortlessAliases,
  stopPortlessProxy,
  type PortlessServiceAlias,
} from "./portless"
import { resolveStartPlan } from "./resolve-options"
import { ensureDockerReady } from "./runtime/docker"
import { stopEnabled, stopLogicalServices } from "./runtime/names"
import { startAspContainer } from "./services/asp"
import {
  isBlockchainBootstrapInProgress,
  startBeeNodes,
  startBlockchain,
  waitForBlockchainBootstrapToSettle,
} from "./services/bee"
import {
  createServiceStartContext,
  type ServiceEnvByKey,
  type ServiceKey,
} from "./services/context"
import { startElastic } from "./services/elastic"
import { startMongo } from "./services/mongo"
import { startShkeeperStack } from "./services/shkeeper"
import { createSession } from "./session"
import { fetchFirstShkeeperWalletApiKey, getEnvVar, logError } from "./utils"

import type {
  EthernaServiceName,
  EthernaSessionHandle,
  ShkeeperConfig,
  StartOptions,
} from "./types"
import type { ChildProcess } from "node:child_process"

/**
 * Stops the Docker container groups for the named logical service(s). Multi-container services stop
 * as a whole group and overlapping groups are de-duplicated (see {@link containerNamesFor}).
 * Throws a `TypeError` (listing valid names) for any unknown service name.
 */
export async function stop(services: EthernaServiceName | EthernaServiceName[]): Promise<void> {
  const names = Array.isArray(services) ? services : [services]
  for (const name of names) {
    if (!ALL_SERVICE_NAMES.includes(name)) {
      throw new TypeError(
        `Unknown Etherna service "${String(name)}". Valid services: ${ALL_SERVICE_NAMES.join(", ")}.`,
      )
    }
  }
  await stopLogicalServices(names)
}

/** Reads per-service env overrides from a `StartOptions` service value (`boolean | { env }`). */
function readServiceEnv<K extends ServiceKey>(value: StartOptions[K]): ServiceEnvByKey[K] {
  return typeof value === "object" && value !== null
    ? ((value.env ?? {}) as ServiceEnvByKey[K])
    : ({} as ServiceEnvByKey[K])
}

/** Resolves the ShKeeper configuration object from `StartOptions.shkeeper` (`true | { … }`). */
function readShkeeperConfig(value: StartOptions["shkeeper"]): ShkeeperConfig {
  if (value === true) {
    return {}
  }
  return typeof value === "object" && value !== null ? value : {}
}

/**
 * Starts the enabled Etherna services following the canonical dependency graph
 * ({@link SERVICE_CATALOG}), wiring a {@link createSession} for spawn tracking, Portless bookkeeping,
 * and shutdown. On a startup failure with `onFailure: "stop"`, stops the Docker containers for every
 * enabled service in this run — even when detached — before shutting the session down.
 *
 * Detached mode defaults to `false` unless `options.detached` or `ETHERNA_DETACHED` is set (matches
 * the Vite plugin). The CLI passes `detached: true` by default separately.
 */
export async function start(options: StartOptions = {}): Promise<EthernaSessionHandle> {
  const plan = resolveStartPlan(options)

  await ensureDockerReady()

  const portlessAppPublicUrl = getEnvVar(PORTLESS_URL_ENV)?.trim()
  const appPort = plan.appPort ?? defaultServiceEnvBuildContext(plan.mode).appPort
  const serviceCtx: ServiceEnvBuildContext = {
    mode: plan.mode,
    portless: plan.portless,
    appPort,
    ...(plan.portless && portlessAppPublicUrl
      ? { portlessAppPublicUrl: normalizePortlessAppPublicUrl(portlessAppPublicUrl) }
      : {}),
  }

  const session = createSession({
    detached: plan.detached,
    enabledServices: plan.enabled,
    stopContainersForEnabled: stopEnabled,
    addPortlessAlias: (name, port) => addPortlessAlias(name as PortlessServiceAlias, port),
    removePortlessAliases: (names) => removePortlessAliases(names as PortlessServiceAlias[]),
    stopPortlessProxy,
    isBlockchainBootstrapInProgress,
    waitForBlockchainBootstrapToSettle,
    onBlockchainShutdownWait: () => {
      console.log(
        chalk.yellow(
          `  ➜  ${chalk.bold("etherna-blockchain")}:   Shutdown requested during blockchain initialization. Waiting for a safe shutdown point. Press Ctrl+C again to force exit.`,
        ),
      )
    },
  })

  if (options.installSignalHandlers !== false) {
    session.installSignalHandlers()
  }

  if (plan.portless) {
    await setupPortless(session, serviceCtx, portlessAppPublicUrl)
  }
  // Built once for Portless alias port lookups (only needed when portless is on).
  const builtEnvs = plan.portless ? buildServiceEnvs(serviceCtx) : undefined

  const getServiceEnv = <K extends ServiceKey>(key: K): ServiceEnvByKey[K] =>
    readServiceEnv<K>(options[key])

  const serviceStartCtx = createServiceStartContext({
    detached: plan.detached,
    serviceCtx,
    getServiceEnv,
    pushSpawn: (...procs) => {
      session.pushSpawn(...procs.filter((p): p is ChildProcess => p != null))
    },
    isShutdownRequested: () => session.isShutdownRequested(),
    getShkeeperConfig: () => readShkeeperConfig(options.shkeeper),
    getShkeeperBuild: () => {
      const build = readShkeeperConfig(options.shkeeper).build
      return {
        githubRepo: build?.githubRepo?.trim() || undefined,
        githubBranch: build?.githubBranch?.trim() || undefined,
      }
    },
  })

  const runStartup = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn()
      return !session.isShutdownRequested()
    } catch (error) {
      if (session.isShutdownRequested()) {
        return false
      }
      throw error
    }
  }

  const startCredit = async () => {
    let creditEnv = getServiceEnv("credit")
    if (plan.enabled.shkeeper) {
      const apiKey = await fetchFirstShkeeperWalletApiKey()
      if (apiKey) {
        creditEnv = { ...creditEnv, "Payments:ShKeeper:ApiKey": apiKey }
      }
    }
    await startAspContainer(
      serviceStartCtx,
      "etherna-credit",
      "etherna/etherna-credit:latest",
      creditEnv,
    )
  }

  const startupByCode: Record<StartupCode, () => Promise<boolean>> = {
    "bee-blockchain": () => runStartup(() => startBlockchain(serviceStartCtx)),
    "bee-nodes": () => runStartup(() => startBeeNodes(serviceStartCtx)),
    shkeeper: () => runStartup(() => startShkeeperStack(serviceStartCtx)),
    mongo: () => runStartup(() => startMongo(serviceStartCtx)),
    sso: () =>
      runStartup(() =>
        startAspContainer(
          serviceStartCtx,
          "etherna-sso",
          "etherna/etherna-sso:latest",
          getServiceEnv("sso"),
        ),
      ),
    index: () =>
      runStartup(() =>
        startAspContainer(
          serviceStartCtx,
          "etherna-index",
          "etherna/etherna-index:latest",
          getServiceEnv("index"),
        ),
      ),
    beehive: () =>
      runStartup(() =>
        startAspContainer(
          serviceStartCtx,
          "etherna-beehive",
          "etherna/beehive:latest",
          getServiceEnv("beehive"),
        ),
      ),
    gateway: () =>
      runStartup(() =>
        startAspContainer(
          serviceStartCtx,
          "etherna-gateway",
          "etherna/etherna-gateway:latest",
          getServiceEnv("gateway"),
        ),
      ),
    credit: () => runStartup(startCredit),
    elastic: () => runStartup(() => startElastic(serviceStartCtx)),
  }

  // Portless alias registration, mirroring the Vite plugin: registered in each node's
  // `beforeStartup` so the alias exists before the container's URL is announced.
  const portlessAliasByCode: Partial<Record<StartupCode, () => Promise<void>>> = plan.portless
    ? {
        "bee-blockchain": async () => {
          const beeBase = getEnv("etherna-bee", serviceCtx) ?? {}
          await session.recordPortlessAlias(
            "bee",
            { ...beeBase, ...getServiceEnv("bee") }.BEE_PORT ?? 1633,
          )
        },
        shkeeper: async () => {
          await session.recordPortlessAlias("shkeeper", getEnv("shkeeper", serviceCtx).port)
        },
        sso: async () => {
          await session.recordPortlessAlias(
            "sso",
            parsePortFromAspNetCoreUrls(String(builtEnvs?.["etherna-sso"].ASPNETCORE_URLS)),
          )
        },
        index: async () => {
          await session.recordPortlessAlias(
            "index",
            parsePortFromAspNetCoreUrls(String(builtEnvs?.["etherna-index"].ASPNETCORE_URLS)),
          )
        },
        beehive: async () => {
          await session.recordPortlessAlias(
            "beehive",
            parsePortFromAspNetCoreUrls(String(builtEnvs?.["etherna-beehive"].ASPNETCORE_URLS)),
          )
        },
        gateway: async () => {
          await session.recordPortlessAlias(
            "gateway",
            parsePortFromAspNetCoreUrls(String(builtEnvs?.["etherna-gateway"].ASPNETCORE_URLS)),
          )
        },
        credit: async () => {
          await session.recordPortlessAlias(
            "credit",
            parsePortFromAspNetCoreUrls(String(builtEnvs?.["etherna-credit"].ASPNETCORE_URLS)),
          )
        },
      }
    : {}

  const codes = Object.keys(SERVICE_CATALOG) as StartupCode[]
  const definitions: DependencyRunnerServiceDefinition<StartupCode>[] = codes.map((code) => {
    const node = SERVICE_CATALOG[code]
    const beforeStartup = portlessAliasByCode[code]
    return {
      code,
      dependencies: node.dependencies,
      enabled: plan.enabled[node.service],
      onFailure: node.onFailure,
      startupCallback: startupByCode[code],
      ...(beforeStartup ? { beforeStartup } : {}),
    }
  })

  const runner = createDependencyRunner(definitions, { logError })
  const result = await runner.start()

  if (result.shouldStop && !session.isShutdownRequested()) {
    // Stop containers for every enabled service in this run — required even when detached, since
    // `session.shutdown` only stops containers when attached (see design doc / Task 3 note).
    await stopEnabled(plan.enabled)
    await session.shutdown({ killTrackedSpawns: true })
  }

  return { shutdown: (opts) => session.shutdown(opts) }
}

/** Fail-fast Portless bootstrap: verify the CLI, start the proxy, register the app alias. */
async function setupPortless(
  session: ReturnType<typeof createSession>,
  serviceCtx: ServiceEnvBuildContext,
  portlessAppPublicUrl: string | undefined,
): Promise<void> {
  if (!(await isPortlessCliAvailable())) {
    console.error(
      chalk.red(
        `  portless: CLI not found. Install globally (recommended): npm install -g portless`,
      ),
    )
    process.exit(1)
  }

  try {
    const { startedByUs } = await ensurePortlessProxy()
    session.setPortlessProxyStartedByUs(startedByUs)
  } catch (e) {
    console.error(
      chalk.red(`  portless: failed to start proxy: ${e instanceof Error ? e.message : String(e)}`),
    )
    process.exit(1)
  }

  if (!portlessAppPublicUrl) {
    try {
      await session.recordPortlessAlias("app", serviceCtx.appPort)
    } catch (e) {
      console.error(
        chalk.red(
          `  portless: failed to register aliases: ${e instanceof Error ? e.message : String(e)}`,
        ),
      )
      await session.cleanupPortless()
      process.exit(1)
    }
  }

  const appUrl =
    portlessAppPublicUrl != null && portlessAppPublicUrl !== ""
      ? `${normalizePortlessAppPublicUrl(portlessAppPublicUrl)}/`
      : `${getPortlessPublicUrl("app")}/`
  console.log(chalk.green(`  ➜  ${chalk.bold("app (portless)")}:   ${chalk.cyan(appUrl)}`))
}

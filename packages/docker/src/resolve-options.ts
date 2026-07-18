import type { EthernaServiceName, ServiceConfig, StartOptions } from "./types"

export const ETHERNA_DETACHED_ENV = "ETHERNA_DETACHED"

/**
 * Resolves detached mode: explicit `options.detached` wins, then `ETHERNA_DETACHED` env, then `false`.
 * Env is truthy for `1`, `true`, `yes` (case-insensitive); falsy for `0`, `false`, `no`, or unset.
 * Ported from `src/plugin-define.ts`.
 */
export function resolveDetachedMode(options: Pick<StartOptions, "detached">): boolean {
  if (typeof options.detached === "boolean") {
    return options.detached
  }
  const raw = process.env[ETHERNA_DETACHED_ENV]?.trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "yes"
}

/** `StartOptions` keys that toggle a logical service on/off (excludes `blockchain`, which has no independent toggle). */
type ConfigurableServiceName = Extract<EthernaServiceName, keyof StartOptions>

const CONFIGURABLE_SERVICE_NAMES: readonly ConfigurableServiceName[] = [
  "elastic",
  "mongo",
  "bee",
  "sso",
  "index",
  "gateway",
  "credit",
  "beehive",
  "shkeeper",
]

/**
 * Mirrors `harnessEthernaPlugin`'s `isServiceEnabled` from `src/plugin-define.ts`: a service is
 * enabled unless explicitly set to `false` (as a boolean or via `{ enabled: false }`).
 */
function isServiceOptionEnabled(value: boolean | ServiceConfig<unknown> | undefined): boolean {
  if (typeof value === "object" && value !== null) {
    return value.enabled !== false
  }
  return value !== false
}

/**
 * Mirrors `harnessEthernaPlugin`'s `isShkeeperEnabled` from `src/plugin-define.ts`: shkeeper is
 * opt-in — enabled only when set to `true` or a config object (unless `{ enabled: false }`).
 */
function isShkeeperOptionEnabled(value: boolean | ServiceConfig<unknown> | undefined): boolean {
  if (value === true) {
    return true
  }
  return typeof value === "object" && value !== null ? value.enabled !== false : false
}

export interface StartPlan {
  /**
   * Per-service enabled flags, one per {@link EthernaServiceName}. Reflects only the caller's
   * options and their defaults — dependency expansion (e.g. enabling `gateway` implying `mongo`
   * and `sso`) is `resolveEnabledFromServices`'s responsibility and is applied by the startup
   * orchestrator, not here.
   */
  enabled: Record<EthernaServiceName, boolean>
  detached: boolean
  portless: boolean
  appPort?: number
  mode: "http" | "https"
  installSignalHandlers: boolean
}

/** Resolves a `StartOptions` object into a plan describing which services to run and how. */
export function resolveStartPlan(options: StartOptions): StartPlan {
  const enabled = {} as Record<EthernaServiceName, boolean>
  for (const service of CONFIGURABLE_SERVICE_NAMES) {
    enabled[service] =
      service === "shkeeper"
        ? isShkeeperOptionEnabled(options[service])
        : isServiceOptionEnabled(options[service])
  }
  // `blockchain` has no independent StartOptions toggle; it always mirrors `bee`.
  enabled.blockchain = enabled.bee

  const plan: StartPlan = {
    enabled,
    detached: resolveDetachedMode(options),
    portless: options.portless ?? false,
    mode: options.mode ?? "http",
    installSignalHandlers: options.installSignalHandlers ?? true,
  }
  if (options.appPort !== undefined) {
    plan.appPort = options.appPort
  }
  return plan
}

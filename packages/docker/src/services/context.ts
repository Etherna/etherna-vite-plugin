import type {
  BeeEnv,
  BeehiveEnv,
  CreditEnv,
  ElasticEnv,
  GatewayEnv,
  IndexEnv,
  MongoEnv,
  ServiceEnvBuildContext,
  SsoEnv,
} from "../env"
import type { ShkeeperConfig } from "../types"
import type { ChildProcess } from "node:child_process"

/** Maps each configurable logical service to the env-override shape callers may pass for it. */
export interface ServiceEnvByKey {
  elastic: ElasticEnv
  mongo: MongoEnv
  bee: BeeEnv
  sso: SsoEnv
  index: IndexEnv
  gateway: GatewayEnv
  credit: CreditEnv
  beehive: BeehiveEnv
}

export type ServiceKey = keyof ServiceEnvByKey

/**
 * Everything a service starter needs from the run's session/config, bundled into one object so the
 * manager can wire it once and pass it to every starter. Replaces the per-function
 * `(context, envs, opts)` signatures the starters used before the package split.
 */
export interface ServiceStartContext {
  /** When true, reuse already-running containers and leave them running on shutdown. */
  detached: boolean
  /** Context used to build default service envs (bind URLs vs Portless URLs). */
  serviceCtx: ServiceEnvBuildContext
  /** User-supplied env overrides for a logical service (defaults are merged in by each starter). */
  getServiceEnv: <K extends ServiceKey>(k: K) => ServiceEnvByKey[K]
  /** Tracks spawned child processes so the session can kill them on shutdown (nullish entries ignored). */
  pushSpawn: (...procs: (ChildProcess | null | undefined)[]) => void
  /** True once shutdown has been requested; starters use it to bail out gracefully. */
  isShutdownRequested: () => boolean
  /** Resolved ShKeeper configuration (env, ethereum sidecar, build overrides). */
  getShkeeperConfig: () => ShkeeperConfig
  /** Resolved ShKeeper build source (custom GitHub repo/branch, if any). */
  getShkeeperBuild: () => { githubRepo?: string; githubBranch?: string }
}

/**
 * Builds a {@link ServiceStartContext} from a required `serviceCtx` plus optional overrides. Handy for
 * tests and for the manager, which supplies real `pushSpawn` / config accessors.
 */
export function createServiceStartContext(
  options: Partial<ServiceStartContext> & { serviceCtx: ServiceEnvBuildContext },
): ServiceStartContext {
  return {
    detached: options.detached ?? false,
    serviceCtx: options.serviceCtx,
    getServiceEnv:
      options.getServiceEnv ?? (<K extends ServiceKey>(_k: K) => ({}) as ServiceEnvByKey[K]),
    pushSpawn: options.pushSpawn ?? (() => {}),
    isShutdownRequested: options.isShutdownRequested ?? (() => false),
    getShkeeperConfig: options.getShkeeperConfig ?? (() => ({})),
    getShkeeperBuild: options.getShkeeperBuild ?? (() => ({})),
  }
}

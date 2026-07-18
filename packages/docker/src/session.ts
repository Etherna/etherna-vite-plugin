import type { EthernaServiceName } from "./types"

/** Per-service enabled flags used to decide which containers `stopContainersForEnabled` stops. */
export type EnabledServiceMap = Partial<Record<EthernaServiceName, boolean>>

/** Minimal shape session needs from a tracked child process (avoids a `node:child_process` dependency here). */
export interface TrackedSpawn {
  kill: () => void
}

export interface ShutdownOptions {
  /** Exits the process after shutdown work completes. Defaults to `false`. */
  exitProcess?: boolean
  /** Bypasses the shutdown-in-progress guard and the blockchain-settle wait (used for a forced second Ctrl+C). Defaults to `false`. */
  force?: boolean
  /** Kills tracked spawns. Defaults to `!detached` (i.e. `true` when attached, `false` when detached). */
  killTrackedSpawns?: boolean
}

export interface CreateSessionOptions {
  /**
   * When `true`, reuse already-running containers and leave them (and the portless proxy)
   * running on shutdown. Resolve this before calling `createSession` (see `resolveDetachedMode`).
   */
  detached: boolean
  /** Per-service enabled flags, passed through to `stopContainersForEnabled` as-is. */
  enabledServices: EnabledServiceMap
  /** Stops the Docker containers for `enabledServices`. Only called when not detached. */
  stopContainersForEnabled: (enabled: EnabledServiceMap) => Promise<void>
  /** Registers a Portless alias for `name` -> `port`. Defaults to a no-op (wired to `src/portless.ts` by the caller). */
  addPortlessAlias?: (name: string, port: unknown) => Promise<void>
  /** Removes previously-registered Portless aliases. Defaults to a no-op. */
  removePortlessAliases?: (names: string[]) => Promise<void>
  /** Stops the Portless proxy this session started. Defaults to a no-op. */
  stopPortlessProxy?: () => Promise<void>
  /** True while a blockchain bootstrap is in flight; shutdown waits for it to settle first. Defaults to `() => false`. */
  isBlockchainBootstrapInProgress?: () => boolean
  /** Resolves once an in-progress blockchain bootstrap reaches a safe shutdown point. Defaults to a no-op. */
  waitForBlockchainBootstrapToSettle?: () => Promise<void>
  /** Called once, before awaiting `waitForBlockchainBootstrapToSettle`, e.g. to log a warning. Defaults to a no-op. */
  onBlockchainShutdownWait?: () => void
  /** Injectable `process.exit` stand-in, called with `0` when `shutdown({ exitProcess: true })`. Defaults to `process.exit`. */
  exitProcess?: (code: number) => void
}

export interface EthernaSession {
  isShutdownRequested: () => boolean
  pushSpawn: (...procs: TrackedSpawn[]) => void
  killSpawns: () => void
  getDetached: () => boolean
  setPortlessProxyStartedByUs: (started: boolean) => void
  recordPortlessAlias: (name: string, port: unknown) => Promise<void>
  cleanupPortless: () => Promise<void>
  shutdown: (opts?: ShutdownOptions) => Promise<void>
  installSignalHandlers: () => void
}

/**
 * Owns a Vite/CLI run's spawn tracking, Portless bookkeeping, and shutdown/signal-handling logic.
 * Ported from `harnessEthernaPlugin` in `src/plugin-define.ts`, consolidated so `shutdown` also
 * stops enabled containers (the caller no longer needs to do that separately before shutting down).
 */
export function createSession(options: CreateSessionOptions): EthernaSession {
  const detached = options.detached
  const spawns: TrackedSpawn[] = []
  let portlessProxyStartedByUs = false
  const portlessAliasesRegistered: string[] = []
  let shutdownRequested = false
  let shutdownInProgress = false

  const isBlockchainBootstrapInProgress = options.isBlockchainBootstrapInProgress ?? (() => false)
  const waitForBlockchainBootstrapToSettle =
    options.waitForBlockchainBootstrapToSettle ?? (() => Promise.resolve())
  const onBlockchainShutdownWait = options.onBlockchainShutdownWait ?? (() => {})
  const addPortlessAlias = options.addPortlessAlias ?? (async () => {})
  const removePortlessAliases = options.removePortlessAliases ?? (async () => {})
  const stopPortlessProxy = options.stopPortlessProxy ?? (async () => {})
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code))

  const getDetached = () => detached

  const pushSpawn = (...procs: TrackedSpawn[]) => {
    spawns.push(...procs)
  }

  const killSpawns = () => {
    for (const proc of spawns) {
      proc.kill()
    }
  }

  const setPortlessProxyStartedByUs = (started: boolean) => {
    portlessProxyStartedByUs = started
  }

  const recordPortlessAlias = async (name: string, port: unknown) => {
    await addPortlessAlias(name, port)
    portlessAliasesRegistered.push(name)
  }

  const cleanupPortless = async () => {
    if (detached) {
      return
    }
    if (portlessAliasesRegistered.length > 0) {
      await removePortlessAliases([...portlessAliasesRegistered])
      portlessAliasesRegistered.length = 0
    }
    if (portlessProxyStartedByUs) {
      await stopPortlessProxy()
    }
    portlessProxyStartedByUs = false
  }

  const shutdown = async (opts?: ShutdownOptions) => {
    shutdownRequested = true
    const force = opts?.force ?? false

    if (shutdownInProgress && !force) {
      return
    }
    shutdownInProgress = true

    if (!force && isBlockchainBootstrapInProgress()) {
      onBlockchainShutdownWait()
      await waitForBlockchainBootstrapToSettle()
    }

    if (!detached) {
      await options.stopContainersForEnabled(options.enabledServices)
    }

    await cleanupPortless()

    const killTracked = opts?.killTrackedSpawns ?? !detached
    if (killTracked) {
      killSpawns()
    }

    if (opts?.exitProcess) {
      exitProcess(0)
    }
  }

  const installSignalHandlers = () => {
    process.on("SIGINT", () => {
      process.stdin.resume()
      void (async () => {
        await shutdown({ exitProcess: true, force: shutdownRequested })
      })()
    })
    process.on("SIGTERM", () => {
      void (async () => {
        await shutdown({ force: shutdownRequested })
      })()
    })
  }

  return {
    isShutdownRequested: () => shutdownRequested,
    pushSpawn,
    killSpawns,
    getDetached,
    setPortlessProxyStartedByUs,
    recordPortlessAlias,
    cleanupPortless,
    shutdown,
    installSignalHandlers,
  }
}

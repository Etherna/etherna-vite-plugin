export type DependencyFailureMode = "stop" | "log"

export interface DependencyTreeServiceDefinition<TCode extends string = string> {
  code: TCode
  dependencies?: TCode[]
  /** When `false`, startup is skipped and dependents treat this node as satisfied. Defaults to `true`. */
  enabled?: boolean
  /** Runs after dependencies settle and before `startupCallback` (only when enabled). */
  beforeStartup?: () => void | Promise<void>
  /** Defaults to `"stop"`. */
  onFailure?: DependencyFailureMode
  startupCallback: () => Promise<boolean>
}

export interface DependencyTreeLogger {
  logError: (code: string, message: string) => void
}

export type DependencyTreeServiceStatus = "started" | "failed" | "blocked" | "skipped"

export interface DependencyTreeServiceResult<TCode extends string = string> {
  code: TCode
  status: DependencyTreeServiceStatus
  error?: Error
  blockedBy?: TCode[]
}

export interface DependencyTreeRunResult<TCode extends string = string> {
  shouldStop: boolean
  services: DependencyTreeServiceResult<TCode>[]
}

export class DependencyTreeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DependencyTreeValidationError"
  }
}

function normalizeError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason
  }
  return new Error(String(reason))
}

function blockedByFromDependencyResults<TCode extends string>(
  dependencyCodes: TCode[],
  depResults: DependencyTreeServiceResult<TCode>[],
): TCode[] {
  const out = new Set<TCode>()
  for (let i = 0; i < depResults.length; i++) {
    const r = depResults[i] as DependencyTreeServiceResult<TCode>
    if (r.status === "started" || r.status === "skipped") {
      continue
    }
    if (r.status === "failed") {
      out.add(r.code)
    } else {
      const inherited = r.blockedBy
      if (inherited && inherited.length > 0) {
        for (const c of inherited) {
          out.add(c)
        }
      } else {
        out.add(dependencyCodes[i] as TCode)
      }
    }
  }
  return [...out]
}

export function validateDependencyTree<TCode extends string>(
  services: DependencyTreeServiceDefinition<TCode>[],
): void {
  const codes = new Set<TCode>()
  for (const s of services) {
    if (codes.has(s.code)) {
      throw new DependencyTreeValidationError(`Duplicate service code "${String(s.code)}".`)
    }
    codes.add(s.code)
  }

  for (const s of services) {
    const deps = s.dependencies ?? []
    for (const d of deps) {
      if (d === s.code) {
        throw new DependencyTreeValidationError(
          `Service "${String(s.code)}" cannot depend on itself.`,
        )
      }
      if (!codes.has(d)) {
        throw new DependencyTreeValidationError(
          `Service "${String(s.code)}" depends on unknown service "${String(d)}".`,
        )
      }
    }
  }

  const visiting = new Set<TCode>()
  const visited = new Set<TCode>()
  const byCode = new Map(services.map((s) => [s.code, s] as const))

  function dfs(code: TCode): void {
    if (visited.has(code)) {
      return
    }
    if (visiting.has(code)) {
      throw new DependencyTreeValidationError(
        `Dependency cycle detected involving service "${String(code)}".`,
      )
    }
    visiting.add(code)
    const svc = byCode.get(code)
    if (!svc) {
      return
    }
    for (const d of svc.dependencies ?? []) {
      dfs(d)
    }
    visiting.delete(code)
    visited.add(code)
  }

  for (const s of services) {
    dfs(s.code)
  }
}

export function createDependenciesTree<TCode extends string>(
  services: DependencyTreeServiceDefinition<TCode>[],
  logger: DependencyTreeLogger,
): {
  start: () => Promise<DependencyTreeRunResult<TCode>>
} {
  validateDependencyTree(services)

  const byCode = new Map(services.map((s) => [s.code, s] as const))
  const pending = new Map<TCode, Promise<DependencyTreeServiceResult<TCode>>>()

  function getTask(code: TCode): Promise<DependencyTreeServiceResult<TCode>> {
    const existing = pending.get(code)
    if (existing) {
      return existing
    }

    const svc = byCode.get(code)

    if (!svc) {
      throw new DependencyTreeValidationError(`Unknown service code "${String(code)}".`)
    }

    const task = (async (): Promise<DependencyTreeServiceResult<TCode>> => {
      const dependencyCodes = svc.dependencies ?? []
      const depResults = await Promise.all(dependencyCodes.map((d) => getTask(d)))

      const anyBad = depResults.some(
        (r) => r.status !== "started" && r.status !== "skipped",
      )
      if (anyBad) {
        return {
          code,
          status: "blocked",
          blockedBy: blockedByFromDependencyResults(dependencyCodes, depResults),
        }
      }

      if (svc.enabled === false) {
        return { code, status: "skipped" }
      }

      const mode: DependencyFailureMode = svc.onFailure ?? "stop"

      try {
        if (svc.beforeStartup) {
          await svc.beforeStartup()
        }
        const ok = await svc.startupCallback()
        if (!ok) {
          const err = new Error("Service startup returned false")
          if (mode === "log") {
            logger.logError(String(code), err.message)
          }
          return { code, status: "failed", error: err }
        }
        return { code, status: "started" }
      } catch (reason: unknown) {
        const err = normalizeError(reason)
        if (mode === "log") {
          logger.logError(String(code), err.message)
        }
        return { code, status: "failed", error: err }
      }
    })()

    pending.set(code, task)
    return task
  }

  return {
    start: async () => {
      const serviceResults = await Promise.all(services.map((s) => getTask(s.code)))
      const shouldStop = serviceResults.some(
        (r) => r.status === "failed" && (byCode.get(r.code)?.onFailure ?? "stop") === "stop",
      )
      return { shouldStop, services: serviceResults }
    },
  }
}

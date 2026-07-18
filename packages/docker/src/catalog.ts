import type { EthernaServiceName } from "./types"

/**
 * Canonical startup nodes, mirroring the dependency tree built by today's Vite plugin
 * (`etherna()` in `src/index.ts`). This is intentionally NOT the legacy CLI
 * `SERVICE_DEPENDENCIES` graph (e.g. CLI's `gateway` also depends on `beehive`; the Vite tree's
 * `gateway` only depends on `mongo` + `sso`). The Vite tree is canonical for `@etherna/docker`.
 */
export type StartupCode =
  | "bee-blockchain"
  | "bee-nodes"
  | "shkeeper"
  | "mongo"
  | "sso"
  | "index"
  | "beehive"
  | "gateway"
  | "credit"
  | "elastic"

export interface StartupNodeDefinition {
  code: StartupCode
  /** Logical service name this startup node belongs to (drives its default `enabled` flag). */
  service: EthernaServiceName
  dependencies: StartupCode[]
  onFailure: "stop"
}

export const SERVICE_CATALOG: Record<StartupCode, StartupNodeDefinition> = {
  "bee-blockchain": {
    code: "bee-blockchain",
    service: "bee",
    dependencies: [],
    onFailure: "stop",
  },
  "bee-nodes": {
    code: "bee-nodes",
    service: "bee",
    dependencies: ["bee-blockchain"],
    onFailure: "stop",
  },
  shkeeper: {
    code: "shkeeper",
    service: "shkeeper",
    dependencies: [],
    onFailure: "stop",
  },
  mongo: {
    code: "mongo",
    service: "mongo",
    dependencies: [],
    onFailure: "stop",
  },
  sso: {
    code: "sso",
    service: "sso",
    dependencies: ["mongo"],
    onFailure: "stop",
  },
  index: {
    code: "index",
    service: "index",
    dependencies: ["mongo"],
    onFailure: "stop",
  },
  beehive: {
    code: "beehive",
    service: "beehive",
    dependencies: ["mongo"],
    onFailure: "stop",
  },
  gateway: {
    code: "gateway",
    service: "gateway",
    dependencies: ["mongo", "sso"],
    onFailure: "stop",
  },
  credit: {
    code: "credit",
    service: "credit",
    dependencies: ["mongo", "sso", "shkeeper"],
    onFailure: "stop",
  },
  elastic: {
    code: "elastic",
    service: "elastic",
    dependencies: [],
    onFailure: "stop",
  },
}

/** Every logical service name (including opt-in services). */
export const ALL_SERVICE_NAMES: readonly EthernaServiceName[] = [
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

/** Default `etherna start` / `etherna start all` expansion — shkeeper stays opt-in. */
export const DEFAULT_START_SERVICE_NAMES: readonly EthernaServiceName[] =
  ALL_SERVICE_NAMES.filter((name) => name !== "shkeeper")

/** Startup codes directly implied by a logical service name, before dependency expansion. */
function codesForServiceName(name: EthernaServiceName): StartupCode[] {
  switch (name) {
    case "blockchain":
      return ["bee-blockchain"]
    case "bee":
      return ["bee-blockchain", "bee-nodes"]
    default:
      return [name]
  }
}

/** Transitively expands a set of startup codes to include every code they (recursively) depend on. */
function expandCodes(codes: Iterable<StartupCode>): Set<StartupCode> {
  const out = new Set<StartupCode>()

  function visit(code: StartupCode): void {
    if (out.has(code)) {
      return
    }
    out.add(code)
    for (const dep of SERVICE_CATALOG[code].dependencies) {
      visit(dep)
    }
  }

  for (const code of codes) {
    visit(code)
  }
  return out
}

/**
 * True when `service` is covered by `codes`. `bee` reflects the node group itself
 * (`bee-nodes`) — not merely its `bee-blockchain` dependency — so requesting `"blockchain"` alone
 * does not report `bee` as enabled, while requesting `"bee"` reports both `bee` and `blockchain`
 * (since `bee-nodes` depends on `bee-blockchain`).
 */
function isServiceCoveredByCodes(service: EthernaServiceName, codes: Set<StartupCode>): boolean {
  if (service === "bee") {
    return codes.has("bee-nodes")
  }
  if (service === "blockchain") {
    return codes.has("bee-blockchain")
  }
  return codes.has(service)
}

/**
 * Expands requested logical service names into a full enabled map for every
 * {@link EthernaServiceName}, following the canonical Vite-plugin dependency graph
 * ({@link SERVICE_CATALOG}). Dependencies of a requested service are force-enabled even if not
 * explicitly requested (e.g. requesting `"gateway"` also enables `"mongo"` and `"sso"`).
 */
export function resolveEnabledFromServices(
  names: EthernaServiceName[],
): Record<EthernaServiceName, boolean> {
  const requestedCodes = names.flatMap(codesForServiceName)
  const codes = expandCodes(requestedCodes)

  const enabled = {} as Record<EthernaServiceName, boolean>
  for (const service of ALL_SERVICE_NAMES) {
    enabled[service] = isServiceCoveredByCodes(service, codes)
  }
  return enabled
}

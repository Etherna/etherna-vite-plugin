# Docker / Vite Package Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the repo into `@etherna/docker` + `@etherna/vite-plugin` (both `1.7.0`), with a ServiceManager-centered rewrite so orchestration, CLI, and `start`/`stop` live in docker and the Vite plugin is a thin caller.

**Architecture:** pnpm workspace with `packages/docker` (catalog, runtime, session, manager, CLI) and `packages/vite-plugin` (Vite hooks only). One canonical service catalog drives dependency order for both Node `start` and CLI. Publish workflow builds both packages, gates versions against tag `v*`, and publishes both.

**Tech Stack:** TypeScript, pnpm workspaces, tsup, vitest, Node `>=22`, Docker CLI via `spawn`, Vite peer on vite-plugin only.

**Spec:** `docs/superpowers/specs/2026-07-18-docker-vite-package-split-design.md`

## Global Constraints

- Both packages always share the same version; first release is `1.7.0`
- Dependency direction: `vite-plugin` → `docker` only
- Public docker API is high-level `start` / `stop` (+ required types); no low-level container starters in the public export surface
- `stop` uses exact logical names only (no dep cascade); multi-container logical keys stop the whole group
- Detached/attached and failure shutdown semantics must match current behavior (see spec § Error handling)
- Hard break: vite-plugin exports only plugin surface + Vite helpers
- CLI bin `etherna` lives only on `@etherna/docker`
- Prefer unit tests with mocked `docker`/`spawn`; no live Docker required in CI
- Canonical dependency graph = current Vite plugin tree in `src/index.ts` (unify CLI away from its divergent `SERVICE_DEPENDENCIES`)

---

## File structure (target)

```
/
  package.json                          # private root: pnpm scripts for -r test/build/lint
  pnpm-workspace.yaml
  scripts/check-release-versions.mjs
  packages/
    docker/
      package.json                      # @etherna/docker@1.7.0, bin: etherna
      tsup.config.ts
      tsconfig.json
      vitest.config.ts
      src/
        index.ts                        # export start, stop, types
        bin.ts
        types.ts                        # EthernaServiceName, StartOptions, Session, …
        catalog.ts                      # SERVICE_CATALOG + container name groups
        resolve-options.ts              # enabled flags, detached, service env overrides
        env.ts                          # port of envs.ts
        session.ts                      # spawns, portless state, shutdown, signals
        dependency-runner.ts            # port of dependencies-tree.ts
        manager.ts                      # start() / stop() / shutdown orchestration
        runtime/
          docker.ts                     # ensureDockerReady, startDockerContainer, stop, inspect
          names.ts                      # container names per EthernaServiceName
        services/                       # one module per logical area (not public API)
          mongo.ts
          elastic.ts
          bee.ts                        # blockchain + bee nodes
          asp.ts                        # sso/index/gateway/credit/beehive
          shkeeper.ts
        portless.ts
        builder.ts
        utils.ts
        web3.ts
        consts.ts
        ssl-trust.ts                    # trustContainerCertificate (+ helpers containers need)
        cli.ts                          # parse + runCli
      test/
        catalog.test.ts
        resolve-options.test.ts
        dependency-runner.test.ts
        session.test.ts
        manager-start.test.ts
        manager-stop.test.ts
        cli.test.ts
        env.test.ts
        runtime-docker.test.ts          # port of docker.test.ts (adapted)
        portless.test.ts
        utils.test.ts
    vite-plugin/
      package.json                      # @etherna/vite-plugin@1.7.0, dep workspace:*
      tsup.config.ts
      tsconfig.json
      vitest.config.ts
      src/
        index.ts                        # etherna()
        options.ts                      # defineEthernaPlugin, getDevServerPort, https fallback
        ssl.ts                          # generateSslCertificate for Vite https
        certificate.ts                  # createCertificate used by ssl
      test/
        plugin.test.ts
        options.test.ts
  .github/workflows/main.yml            # dual build/publish + version gate
  README.md                             # both packages
```

Delete root `src/`, root `test/`, root app `tsup`/`vitest` package identity after migration (root becomes private workspace only). Keep root `vite.config.ts` only if still useful as a local playground depending on workspace packages; otherwise remove or point at packages.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `packages/docker/package.json`
- Create: `packages/vite-plugin/package.json`
- Create: `packages/docker/tsconfig.json`, `packages/vite-plugin/tsconfig.json`
- Create: `packages/docker/tsup.config.ts`, `packages/vite-plugin/tsup.config.ts`
- Create: `packages/docker/vitest.config.ts`, `packages/vite-plugin/vitest.config.ts`
- Modify: root `package.json` → private workspace root
- Test: smoke via `pnpm -r typecheck` / empty package build once stub `src/index.ts` exist

**Interfaces:**
- Consumes: none
- Produces: workspace packages `@etherna/docker@1.7.0`, `@etherna/vite-plugin@1.7.0` with `workspace:*` dependency from vite-plugin → docker

- [ ] **Step 1: Create workspace file**

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Create `packages/docker/package.json`**

```json
{
  "name": "@etherna/docker",
  "version": "1.7.0",
  "description": "Orchestrate Etherna Docker services from Node and CLI",
  "author": "Mattia Dalzocchio",
  "license": "LGPL-3.0-or-later",
  "type": "module",
  "files": ["dist"],
  "main": "dist/index.cjs",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "etherna": "dist/bin.cjs"
  },
  "scripts": {
    "build": "pnpm tsup",
    "test": "pnpm vitest run",
    "typecheck": "pnpm tsc --noEmit",
    "lint": "pnpm oxlint",
    "format": "pnpm oxfmt"
  },
  "dependencies": {
    "@noble/curves": "^2.2.0",
    "@noble/hashes": "^2.2.0",
    "node-forge": "1.4.0"
  },
  "devDependencies": {
    "@types/node": "25.6.0",
    "@types/node-forge": "1.3.14",
    "chalk": "5.6.2",
    "tsup": "8.5.1",
    "typescript": "6.0.2",
    "vitest": "3.2.4"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

(Copy repository/bugs/homepage fields from current root `package.json`.)

- [ ] **Step 3: Create `packages/vite-plugin/package.json`**

```json
{
  "name": "@etherna/vite-plugin",
  "version": "1.7.0",
  "description": "Vite plugin for Etherna services",
  "author": "Mattia Dalzocchio",
  "license": "LGPL-3.0-or-later",
  "type": "module",
  "files": ["dist"],
  "main": "dist/index.cjs",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "pnpm tsup",
    "test": "pnpm vitest run",
    "typecheck": "pnpm tsc --noEmit",
    "lint": "pnpm oxlint",
    "format": "pnpm oxfmt"
  },
  "peerDependencies": {
    "vite": "^7.0.0 || ^8.0.0"
  },
  "dependencies": {
    "@etherna/docker": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "25.6.0",
    "chalk": "5.6.2",
    "tsup": "8.5.1",
    "typescript": "6.0.2",
    "vite": "8.0.8",
    "vitest": "3.2.4"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

- [ ] **Step 4: Convert root `package.json` to private workspace**

Set `"private": true`, remove `main`/`module`/`types`/`bin`/`files`, keep shared lint/format tooling and scripts:

```json
{
  "private": true,
  "scripts": {
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "typecheck": "pnpm -r run typecheck",
    "lint": "pnpm oxlint",
    "format": "pnpm oxfmt",
    "format:check": "pnpm oxfmt --check",
    "check-release-versions": "node scripts/check-release-versions.mjs"
  },
  "packageManager": "pnpm@10.26.0+sha512.3b3f6c725ebe712506c0ab1ad4133cf86b1f4b687effce62a9b38b4d72e3954242e643190fc51fa1642949c735f403debd44f5cb0edd657abe63a8b6a7e1e402",
  "engines": { "node": ">=22.0.0" }
}
```

Keep root `devDependencies` for oxlint/oxfmt/typescript as needed for workspace-wide tooling, or hoist via pnpm.

- [ ] **Step 5: Add stub entrypoints so install/build works**

`packages/docker/src/index.ts`:

```ts
export async function start(_options: Record<string, unknown> = {}) {
  return { shutdown: async () => {} }
}

export async function stop(_services: string | string[]) {}
```

`packages/docker/src/bin.ts`:

```ts
console.error("etherna CLI not implemented yet")
process.exit(1)
```

`packages/vite-plugin/src/index.ts`:

```ts
import type { Plugin } from "vite"

export function etherna(_options: Record<string, unknown> = {}): Plugin {
  return { name: "etherna:vite-plugin", apply: "serve" }
}
```

Copy `tsup.config.ts` patterns from root into each package (docker: `index` + `bin`; vite-plugin: `index` only, external `vite` + `@etherna/docker`).

- [ ] **Step 6: Install and verify**

Run: `pnpm install && pnpm -r run build`

Expected: both packages emit `dist/`; no errors.

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml package.json packages pnpm-lock.yaml
git commit -m "chore: scaffold pnpm workspace for docker and vite-plugin packages"
```

---

### Task 2: Types, catalog, and option resolution

**Files:**
- Create: `packages/docker/src/types.ts`
- Create: `packages/docker/src/catalog.ts`
- Create: `packages/docker/src/runtime/names.ts`
- Create: `packages/docker/src/resolve-options.ts`
- Create: `packages/docker/test/catalog.test.ts`
- Create: `packages/docker/test/resolve-options.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `EthernaServiceName`
  - `StartOptions`, `ServiceConfig<T>`, `ShkeeperConfig`, …
  - `SERVICE_CATALOG` with deps + `startupCodes`
  - `containerNamesFor(service: EthernaServiceName): string[]`
  - `resolveStartPlan(options: StartOptions): { enabled: Record<…>; detached: boolean; … }`

- [ ] **Step 1: Write failing catalog/name tests**

```ts
// packages/docker/test/catalog.test.ts
import { describe, expect, it } from "vitest"
import { SERVICE_CATALOG, resolveEnabledFromServices } from "../src/catalog.ts"
import { containerNamesFor } from "../src/runtime/names.ts"

describe("containerNamesFor", () => {
  it("returns the full bee group", () => {
    expect(containerNamesFor("bee")).toEqual([
      "etherna-blockchain",
      "etherna-bee",
      "etherna-bee_worker_1",
    ])
  })

  it("returns blockchain only", () => {
    expect(containerNamesFor("blockchain")).toEqual(["etherna-blockchain"])
  })

  it("returns the full shkeeper stack", () => {
    expect(containerNamesFor("shkeeper")).toEqual([
      "ethereum-shkeeper-mariadb",
      "ethereum-shkeeper-redis",
      "ethereum-shkeeper",
      "ethereum-tasks",
      "shkeeper",
    ])
  })
})

describe("resolveEnabledFromServices", () => {
  it("includes transitive deps for gateway using the Vite canonical graph", () => {
    expect(resolveEnabledFromServices(["gateway"])).toMatchObject({
      mongo: true,
      sso: true,
      gateway: true,
      // beehive is NOT required by Vite gateway deps — do not invent CLI-only deps
      beehive: false,
      bee: false,
    })
  })
})
```

Note: `bee` containers include blockchain in `containerNamesFor("bee")` to match today’s `stopEnabledEthernaContainers` when `bee: true`. `stop("blockchain")` stops only the blockchain container.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `pnpm --filter @etherna/docker test -- catalog.test.ts`

Expected: FAIL (modules missing)

- [ ] **Step 3: Implement types + names + catalog**

```ts
// packages/docker/src/types.ts
export type EthernaServiceName =
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

export interface ServiceConfig<TEnv> {
  enabled?: boolean
  env?: TEnv
}

export interface StartOptions {
  detached?: boolean
  portless?: boolean
  appPort?: number
  installSignalHandlers?: boolean
  mode?: "http" | "https"
  elastic?: boolean | ServiceConfig<Record<string, string>>
  mongo?: boolean | ServiceConfig<Record<string, string>>
  bee?: boolean | ServiceConfig<Record<string, string>>
  sso?: boolean | ServiceConfig<Record<string, string>>
  index?: boolean | ServiceConfig<Record<string, string>>
  gateway?: boolean | ServiceConfig<Record<string, string>>
  credit?: boolean | ServiceConfig<Record<string, string>>
  beehive?: boolean | ServiceConfig<Record<string, string>>
  shkeeper?: boolean | ShkeeperConfig
}

// Define ShkeeperConfig / env types by porting from current plugin-define.ts + envs.ts
```

Use **precise env types** from current `src/envs.ts` (not `Record<string, string>` in the final code — the sketch above is abbreviated; implement with `ElasticEnv`, `MongoEnv`, etc.).

Canonical startup nodes (match `src/index.ts` tree):

| code | enabled when | dependencies | onFailure |
|------|--------------|--------------|-----------|
| `bee-blockchain` | `bee` | — | stop |
| `bee-nodes` | `bee` | `bee-blockchain` | stop |
| `shkeeper` | `shkeeper` | — | stop |
| `mongo` | `mongo` | — | stop |
| `sso` | `sso` | `mongo` | stop |
| `index` | `index` | `mongo` | stop |
| `beehive` | `beehive` | `mongo` | stop |
| `gateway` | `gateway` | `mongo`, `sso` | stop |
| `credit` | `credit` | `mongo`, `sso`, `shkeeper` | stop |
| `elastic` | `elastic` | — | stop |

`resolveEnabledFromServices(names)` expands CLI service names into enabled flags + required startup codes using this graph (including `blockchain` → `bee-blockchain` only, `bee` → both bee codes).

- [ ] **Step 4: Implement `resolveDetachedMode` + `resolveStartPlan` in `resolve-options.ts`**

Port `ETHERNA_DETACHED` / `resolveDetachedMode` from `src/plugin-define.ts`. Default service enablement when options omit services: match current plugin defaults (services enabled unless set `false` — verify against `harnessEthernaPlugin` / `isServiceEnabled`).

- [ ] **Step 5: Run tests — expect PASS**

Run: `pnpm --filter @etherna/docker test -- catalog.test.ts resolve-options.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/docker
git commit -m "feat(docker): add service catalog, names, and start option resolution"
```

---

### Task 3: Dependency runner + session

**Files:**
- Create: `packages/docker/src/dependency-runner.ts` (port `src/dependencies-tree.ts`)
- Create: `packages/docker/src/session.ts`
- Create: `packages/docker/test/dependency-runner.test.ts` (move/adapt `test/dependencies-tree.test.ts`)
- Create: `packages/docker/test/session.test.ts`

**Interfaces:**
- Consumes: catalog startup codes
- Produces:
  - `createDependencyRunner(defs, logger).start(): Promise<{ shouldStop: boolean; results: … }>`
  - `createSession(opts): EthernaSession` with `pushSpawn`, `shutdown`, `installSignalHandlers`, portless bookkeeping, `isShutdownRequested`, blockchain settle hooks

- [ ] **Step 1: Move dependency-tree tests into docker package and fix imports**

Adapt `test/dependencies-tree.test.ts` → `packages/docker/test/dependency-runner.test.ts` importing from `../src/dependency-runner.ts`. Keep behavior identical; rename symbols if desired (`createDependenciesTree` → `createDependencyRunner`) but update all call sites/tests together.

- [ ] **Step 2: Run tests — expect FAIL then port implementation until PASS**

Run: `pnpm --filter @etherna/docker test -- dependency-runner.test.ts`

- [ ] **Step 3: Write session tests (failing)**

```ts
// packages/docker/test/session.test.ts
import { describe, expect, it, vi } from "vitest"
import { createSession } from "../src/session.ts"

describe("createSession", () => {
  it("shutdown in attached mode stops enabled containers and kills spawns", async () => {
    const stopContainers = vi.fn(async () => {})
    const kill = vi.fn()
    const session = createSession({
      detached: false,
      enabledServices: { mongo: true, bee: false, sso: false, index: false, gateway: false, credit: false, beehive: false, elastic: false, shkeeper: false },
      stopContainersForEnabled: stopContainers,
      // inject blockchain wait no-ops
    })
    session.pushSpawn({ kill } as never)
    await session.shutdown()
    expect(stopContainers).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledOnce()
  })

  it("shutdown in detached mode does not stop containers", async () => {
    const stopContainers = vi.fn(async () => {})
    const session = createSession({
      detached: true,
      enabledServices: { mongo: true, bee: false, sso: false, index: false, gateway: false, credit: false, beehive: false, elastic: false, shkeeper: false },
      stopContainersForEnabled: stopContainers,
    })
    await session.shutdown()
    expect(stopContainers).not.toHaveBeenCalled()
  })
})
```

Implement session by porting shutdown/portless/signal logic from `src/plugin-define.ts` `harnessEthernaPlugin` (lines covering `shutdownServices`, `killSpawns`, `cleanupPortless`, `installProcessSignalHandlers`) plus blockchain wait imports from runtime.

**Detached shutdown rules (must match spec):** do not stop containers; do not stop portless proxy; killTrackedSpawns defaults false in detached unless `shutdown({ killTrackedSpawns: true })` (CLI failure path).

- [ ] **Step 4: Implement session until tests pass**

- [ ] **Step 5: Commit**

```bash
git add packages/docker
git commit -m "feat(docker): add dependency runner and session shutdown"
```

---

### Task 4: Container runtime + service starters (internal)

**Files:**
- Create: `packages/docker/src/runtime/docker.ts` (core of `src/docker.ts`)
- Create: `packages/docker/src/services/*.ts` (split by domain)
- Create: `packages/docker/src/env.ts`, `portless.ts`, `builder.ts`, `utils.ts`, `web3.ts`, `consts.ts`, `ssl-trust.ts`
- Create/adapt tests under `packages/docker/test/` from existing `docker`/`envs`/`portless`/`utils` tests

**Interfaces:**
- Consumes: session (`pushSpawn`, detached flag), env builder, catalog
- Produces: internal starters used only by manager, e.g. `startMongo(ctx)`, `startBeeNodes(ctx)`, … — **not** re-exported from `packages/docker/src/index.ts`

- [ ] **Step 1: Move supporting modules**

Move with import-path updates (behavior-preserving):

| From | To |
|------|----|
| `src/envs.ts` | `packages/docker/src/env.ts` |
| `src/portless.ts` | `packages/docker/src/portless.ts` |
| `src/builder.ts` | `packages/docker/src/builder.ts` |
| `src/utils.ts` | `packages/docker/src/utils.ts` |
| `src/web3.ts` | `packages/docker/src/web3.ts` |
| `src/consts.ts` | `packages/docker/src/consts.ts` |
| `trustContainerCertificate` / container SSL bits from `src/ssl.ts` | `packages/docker/src/ssl-trust.ts` |

Move matching tests; run `pnpm --filter @etherna/docker test -- env.test.ts portless.test.ts utils.test.ts` until green.

- [ ] **Step 2: Split `src/docker.ts` into runtime + services**

Keep function bodies; change signatures to accept a shared `ServiceStartContext`:

```ts
export interface ServiceStartContext {
  detached: boolean
  serviceCtx: ServiceEnvBuildContext
  getServiceEnv: <K extends ServiceKey>(k: K) => ServiceEnvByKey[K]
  pushSpawn: (...procs: (ChildProcess | null | undefined)[]) => void
  isShutdownRequested: () => boolean
  getShkeeperConfig: () => ShkeeperConfig
  getShkeeperBuild: () => { githubRepo?: string; githubBranch?: string }
}
```

Map existing exports:

| Existing | New home |
|----------|----------|
| `ensureDockerReady`, `startDockerContainer`, `isContainerRunning`, `stopContainer` | `runtime/docker.ts` |
| `stopEnabledEthernaContainers` | `runtime/names.ts` helper `stopLogicalServices(names)` / `stopEnabled(enabled)` |
| `startMongoDbContainer` | `services/mongo.ts` |
| `startElasticContainer` | `services/elastic.ts` |
| `startBlockchain`, `startBeeNodes`, `startBeeNode`, `startInterceptor` | `services/bee.ts` |
| `startAspContainer` | `services/asp.ts` |
| `startShkeeper*` | `services/shkeeper.ts` |

Adapt `test/docker.test.ts` imports; keep assertions. Prefer injecting `spawn` for new tests; existing tests may keep current style.

- [ ] **Step 3: Run docker package tests**

Run: `pnpm --filter @etherna/docker test`

Expected: PASS for moved suites (fix import paths / renames only).

- [ ] **Step 4: Commit**

```bash
git add packages/docker
git commit -m "refactor(docker): split container runtime and per-service starters"
```

---

### Task 5: `start` and `stop` (ServiceManager)

**Files:**
- Create: `packages/docker/src/manager.ts`
- Modify: `packages/docker/src/index.ts` (real exports)
- Create: `packages/docker/test/manager-start.test.ts`
- Create: `packages/docker/test/manager-stop.test.ts`

**Interfaces:**
- Consumes: catalog, resolve-options, session, dependency-runner, services/*, portless, env
- Produces:

```ts
export interface EthernaSessionHandle {
  shutdown: (opts?: { killTrackedSpawns?: boolean }) => Promise<void>
}

export function start(options?: StartOptions): Promise<EthernaSessionHandle>
export function stop(services: EthernaServiceName | EthernaServiceName[]): Promise<void>
```

- [ ] **Step 1: Write failing manager tests**

```ts
// packages/docker/test/manager-stop.test.ts
import { describe, expect, it, vi } from "vitest"

vi.mock("../src/runtime/docker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/docker.ts")>()
  return {
    ...actual,
    stopContainer: vi.fn(async () => {}),
    ensureDockerReady: vi.fn(async () => {}),
  }
})

import { stop } from "../src/manager.ts"
import { stopContainer } from "../src/runtime/docker.ts"

describe("stop", () => {
  it("stops only named logical groups", async () => {
    await stop(["mongo", "sso"])
    expect(stopContainer).toHaveBeenCalledWith("etherna-mongodb")
    expect(stopContainer).toHaveBeenCalledWith("etherna-sso")
    expect(stopContainer).not.toHaveBeenCalledWith("etherna-gateway")
  })

  it("stops the full bee group for bee", async () => {
    await stop("bee")
    expect(stopContainer).toHaveBeenCalledWith("etherna-blockchain")
    expect(stopContainer).toHaveBeenCalledWith("etherna-bee")
    expect(stopContainer).toHaveBeenCalledWith("etherna-bee_worker_1")
  })
})
```

```ts
// packages/docker/test/manager-start.test.ts
// Mock ensureDockerReady + per-service starters OR dependency runner callbacks
// Assert:
// 1) start({ mongo: true, installSignalHandlers: false }) runs mongo starter
// 2) onFailure stop path calls stop for all enabled + shutdown(killTrackedSpawns: true)
// 3) detached default false for start() when unset (plugin default); document CLI overrides to true
```

Clarify defaults in implementation:

- `start()` detached: `resolveDetachedMode(options)` → false unless option/env set (matches Vite plugin)
- CLI passes `detached: options.detached ?? true` into `start`

- [ ] **Step 2: Run tests — expect FAIL**

Run: `pnpm --filter @etherna/docker test -- manager-stop.test.ts manager-start.test.ts`

- [ ] **Step 3: Implement `manager.ts`**

Algorithm for `start(options)`:

1. `const plan = resolveStartPlan(options)`
2. `await ensureDockerReady()`
3. `const session = createSession({ detached: plan.detached, enabledServices: plan.enabled, … })`
4. If `options.installSignalHandlers !== false`, `session.installSignalHandlers()`
5. Build `serviceCtx` from `mode` / `portless` / `appPort` / `PORTLESS_URL`
6. If portless: same fail-fast + proxy + app alias flow as current `src/index.ts` / `src/cli.ts`
7. Build dependency defs from `SERVICE_CATALOG` filtered by enabled flags; wire `beforeStartup` portless aliases; `startupCallback` → service starters that `pushSpawn`
8. `const result = await runner.start()`; if `result.shouldStop && !session.isShutdownRequested()`, `await stopEnabled(plan.enabled)` then `await session.shutdown({ killTrackedSpawns: true })`
9. Return `{ shutdown: (opts) => session.shutdown(opts) }`

Algorithm for `stop(services)`:

1. Normalize to array
2. Validate each name is `EthernaServiceName` (throw `TypeError` / custom error listing valid names)
3. `await Promise.all(uniqueContainerNames.map(stopContainer))`

- [ ] **Step 4: Export from `packages/docker/src/index.ts`**

```ts
export { start, stop } from "./manager.ts"
export type {
  EthernaServiceName,
  EthernaSessionHandle,
  StartOptions,
  ServiceConfig,
  ShkeeperConfig,
  // env types needed by StartOptions
} from "./types.ts"
export { ETHERNA_DETACHED_ENV, resolveDetachedMode } from "./resolve-options.ts"
// Do NOT export startMongoDbContainer / ensureDockerReady / etc.
```

- [ ] **Step 5: Run all docker tests — PASS**

Run: `pnpm --filter @etherna/docker test`

- [ ] **Step 6: Commit**

```bash
git add packages/docker
git commit -m "feat(docker): implement start and stop ServiceManager API"
```

---

### Task 6: CLI (`etherna start` / `stop` / `help`)

**Files:**
- Create: `packages/docker/src/cli.ts`
- Modify: `packages/docker/src/bin.ts`
- Create: `packages/docker/test/cli.test.ts` (adapt `test/cli.test.ts` + add stop cases)

**Interfaces:**
- Consumes: `start`, `stop`, `resolveEnabledFromServices`, env context helpers
- Produces: `parseCliArgs`, `runCli`, `getCliHelp`

- [ ] **Step 1: Write/extend CLI tests**

Port existing parse/selection tests. Update selection expectations to the **canonical Vite graph** (Task 2). Add:

```ts
it("parses stop command", () => {
  expect(parseCliArgs(["stop", "mongo", "sso"])).toEqual({
    command: "stop",
    services: ["mongo", "sso"],
    options: {},
  })
})

it("rejects stop without services", () => {
  expect(() => parseCliArgs(["stop"])).toThrow(/service/i)
})
```

- [ ] **Step 2: Implement CLI**

`runCli`:

- `help` → print help, exit 0
- `start` → map services → `StartOptions` via `resolveEnabledFromServices` + flags; `detached: parsed.detached ?? true`; `await start({…, installSignalHandlers: true})`; if detached, exit after start (containers left running); if attached, keep process alive until signal/`shutdown` (match current CLI attached behavior — read current `startCliServices` / `runCli` and preserve)
- `stop` → `await stop(services)`

Replace `packages/docker/src/bin.ts`:

```ts
import { runCli } from "./cli.ts"

void runCli()
```

- [ ] **Step 3: Run CLI tests — PASS**

Run: `pnpm --filter @etherna/docker test -- cli.test.ts`

- [ ] **Step 4: Commit**

```bash
git add packages/docker
git commit -m "feat(docker): add etherna CLI start and stop commands"
```

---

### Task 7: Thin Vite plugin

**Files:**
- Create: `packages/vite-plugin/src/options.ts`
- Create: `packages/vite-plugin/src/ssl.ts`, `certificate.ts` (from current vite SSL path)
- Create: `packages/vite-plugin/src/index.ts` (real `etherna`)
- Create: `packages/vite-plugin/test/plugin.test.ts`, `options.test.ts`
- Delete or stop using root `src/` once vite-plugin works

**Interfaces:**
- Consumes: `start` from `@etherna/docker`, `StartOptions` types
- Produces:

```ts
export type EthernaPluginOptions = StartOptions & {
  enabled?: boolean
  https?: boolean
}

export function etherna(options?: EthernaPluginOptions): Plugin
export function defineEthernaPlugin(options: EthernaPluginOptions): EthernaPluginOptions
export function getDevServerPort(server: ViteDevServer, fallbackPort: number): number
export function applyEthernaPluginHttpsFallback(options: EthernaPluginOptions): void
```

- [ ] **Step 1: Write plugin tests with mocked docker**

```ts
const start = vi.fn(async () => ({ shutdown: vi.fn(async () => {}) }))
vi.mock("@etherna/docker", () => ({ start }))

// Build plugin, simulate configureServer + listening + close
// Assert start called with appPort and service options
// Assert shutdown called on close
// Assert enabled: false skips start
```

- [ ] **Step 2: Implement plugin**

Port env-prefix loading + SSL `configResolved` from `src/index.ts`. In `configureServer`:

```ts
if (options.enabled === false) {
  console.log(/* existing message */)
  return
}

server.httpServer?.once("listening", async () => {
  const appPort = getDevServerPort(server, fallbackPort)
  const { https: _https, enabled: _enabled, ...startOpts } = options
  const { shutdown } = await start({
    ...startOpts,
    appPort,
    mode: options.https ? "https" : "http",
    installSignalHandlers: true,
  })
  // store shutdown on closure
})

server.httpServer?.once("close", async () => {
  await shutdown?.()
})
```

Do not import catalog/runners/starters in vite-plugin.

- [ ] **Step 3: Port option helper tests from `test/plugin-define.test.ts`** (only Vite helpers + detached resolution if re-exported from docker — prefer importing `resolveDetachedMode` from `@etherna/docker` in tests that need it, or drop from vite-plugin tests)

- [ ] **Step 4: Run vite-plugin tests — PASS**

Run: `pnpm --filter @etherna/vite-plugin test`

- [ ] **Step 5: Remove obsolete root `src/` and `test/` after confirming packages own everything**

Update any remaining root configs. Ensure `pnpm test` at root runs both packages.

- [ ] **Step 6: Commit**

```bash
git add packages/vite-plugin packages/docker package.json
git rm -r src test  # when ready
git commit -m "feat(vite-plugin): thin plugin using @etherna/docker start/shutdown"
```

---

### Task 8: Publish workflow + version gate

**Files:**
- Create: `scripts/check-release-versions.mjs`
- Create: `scripts/check-release-versions.test.mjs` OR vitest test that shells the script (optional but preferred)
- Modify: `.github/workflows/main.yml`
- Modify: root `package.json` script `check-release-versions` (already referenced in Task 1)

**Interfaces:**
- Consumes: `GITHUB_REF_NAME` or CLI arg tag; both package.json versions
- Produces: exit 0 if `v${dockerVersion} === tag` and versions equal; else exit 1 with clear stderr

- [ ] **Step 1: Write the version check script**

```js
#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const tag = process.argv[2] || process.env.GITHUB_REF_NAME
if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error(`Invalid or missing tag: ${tag}`)
  process.exit(1)
}
const expected = tag.slice(1)

const docker = JSON.parse(readFileSync(resolve("packages/docker/package.json"), "utf8"))
const vite = JSON.parse(readFileSync(resolve("packages/vite-plugin/package.json"), "utf8"))

if (docker.version !== expected || vite.version !== expected || docker.version !== vite.version) {
  console.error(
    `Version mismatch: tag=${tag} docker=${docker.version} vite-plugin=${vite.version}`,
  )
  process.exit(1)
}
console.log(`OK: ${tag} matches both packages @ ${expected}`)
```

(Allow pre-release tags only if you already use them; otherwise keep strict `vX.Y.Z`.)

- [ ] **Step 2: Manual verify**

Run: `node scripts/check-release-versions.mjs v1.7.0` → OK  
Run: `node scripts/check-release-versions.mjs v9.9.9` → exit 1

- [ ] **Step 3: Update `.github/workflows/main.yml`**

- `pnpm install`
- `pnpm test` (re-enable tests)
- `pnpm build`
- Cache `**/dist` or build again in publish job
- Before publish: `node scripts/check-release-versions.mjs ${{ github.ref_name }}`
- Publish:
  - `pnpm --filter @etherna/docker publish --access public --no-git-checks`
  - `pnpm --filter @etherna/vite-plugin publish --access public --no-git-checks`
- Keep OIDC `id-token: write` and create-release job

Use npm/pnpm publish from each package directory as required by the registry setup; ensure `NODE_AUTH_TOKEN` / OIDC still works for both.

- [ ] **Step 4: Commit**

```bash
git add scripts .github/workflows/main.yml package.json
git commit -m "ci: publish both packages with matching version tag gate"
```

---

### Task 9: Docs + final cleanup

**Files:**
- Modify: `README.md`
- Modify: package repository fields if needed
- Verify: no leftover references to root `src/` in configs
- Optional: short `packages/docker/README.md` for Node `start`/`stop` + CLI

- [ ] **Step 1: Update root README**

Document:

- Installing `@etherna/vite-plugin` (pulls docker)
- Installing `@etherna/docker` alone for Node/CLI
- `import { start, stop } from "@etherna/docker"`
- `etherna start` / `etherna stop`
- Breaking change: types/helpers moved to docker
- Detached / portless sections (point at docker behavior)

- [ ] **Step 2: Full verification**

Run:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
node scripts/check-release-versions.mjs v1.7.0
```

Expected: all green; both `dist` folders populated; version script OK.

- [ ] **Step 3: Commit**

```bash
git add README.md packages
git commit -m "docs: document docker and vite-plugin package split for 1.7.0"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| pnpm monorepo `packages/docker` + `packages/vite-plugin` | 1 |
| `@etherna/docker` owns orchestration + CLI + start/stop | 4–6 |
| ServiceManager clean rewrite | 2–5 |
| vite-plugin thin `start`/`shutdown` | 7 |
| Hard break exports | 5 (index exports), 7 |
| Same version `1.7.0` | 1, 8 |
| `stop` exact logical names; bee/shkeeper groups | 2, 5 |
| Detached/attached + failure shutdown | 3, 5 |
| CLI start + stop | 6 |
| Tests moved + new start/stop/CLI stop | 2–7 |
| Publish both + version gate vs `v*` | 8 |
| README / migration | 9 |
| Canonical dep graph = Vite tree | 2, 6 (CLI tests updated) |

No TBD placeholders left. Types named consistently: `EthernaServiceName`, `StartOptions`, `EthernaSessionHandle`, `start`, `stop`.

# Design: Split `@etherna/docker` and `@etherna/vite-plugin`

**Date:** 2026-07-18  
**Status:** Approved for planning  
**First release version:** `1.7.0` (both packages, always identical)

## Goal

Split the current single package into two published packages in a pnpm monorepo:

- **`@etherna/docker`** — core orchestration, Node `start`/`stop` API, and `etherna` CLI
- **`@etherna/vite-plugin`** — thin Vite plugin that starts/shuts down services via `@etherna/docker`

Improve maintainability with a clean ServiceManager-centered rewrite (not a line-for-line file move with dual startup paths).

## Non-goals

- Renaming the GitHub repository
- Publishing the workspace root package
- Supporting mismatched package versions
- Cascading stop along the dependency graph (upstream or downstream)
- Keeping a long deprecation window for non-plugin exports on `@etherna/vite-plugin`

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Source layout | pnpm monorepo in this repo (`packages/docker`, `packages/vite-plugin`) |
| CLI availability | Bin lives on `@etherna/docker` only; vite-plugin depends on docker so `etherna` remains available after installing the plugin |
| Public API break | Hard break: vite-plugin keeps plugin-specific utils only; everything else moves to docker |
| Versioning | Both packages always share the same version; ship as `1.7.0` |
| Docker public API | High-level `start` / `stop` (+ types); export additional symbols only when vite-plugin needs them |
| `stop` semantics | Exact logical service names only (no dep cascade) |
| Multi-container services | Logical keys (`bee`, `shkeeper`, …) stop the whole container group |
| Implementation style | Clean rewrite around ServiceManager (Approach 3) |

## Architecture

```
/
  package.json                 # private workspace root (scripts, shared tooling)
  pnpm-workspace.yaml
  packages/
    docker/                    # @etherna/docker @ 1.7.0
    vite-plugin/               # @etherna/vite-plugin @ 1.7.0 → depends on @etherna/docker
  .github/workflows/…          # build both, version-gate, publish both on tag v*
```

**Dependency direction:** `vite-plugin` → `docker` only. Never the reverse.

### `@etherna/docker` owns

- Service catalog + dependency graph
- Container lifecycle (run / reuse / stop)
- Session tracking (attached child processes)
- Public Node API: `start`, `stop`
- CLI binary `etherna` (`start`, `stop`, `help`)
- Portless integration used during orchestration
- Env building and service option types used by start/CLI

### `@etherna/vite-plugin` owns

- Vite plugin surface (`etherna()`, `defineEthernaPlugin`)
- Vite-only helpers (e.g. `getDevServerPort`, `applyEthernaPluginHttpsFallback`)
- Loading `ETHERNA_` / `PORTLESS_` from Vite env files into `process.env`
- SSL cert injection for Vite server/preview
- Calling docker `start` on server listen and `shutdown` on close / failure

## Core components (`@etherna/docker`)

Rewrite around small units with clear jobs:

| Unit | Responsibility |
|------|----------------|
| **Service catalog** | Logical keys → dependencies, container group, starter |
| **Env builder** | Typed env maps from options + context (app port, portless, http/https mode) |
| **Container runtime** | Low-level docker run / inspect / stop; detached session handling |
| **Dependency runner** | Topological start with `onFailure: "stop" \| "log"` (evolve today’s tree) |
| **Session** | Tracks spawned processes and which logical services this run owns |
| **ServiceManager** | Orchestrates the above; implements public `start` / `stop` / session `shutdown` |

### Public Node API

Logical service names (`EthernaServiceName`) match today’s CLI vocabulary (excluding `all`):

`blockchain` | `bee` | `beehive` | `credit` | `elastic` | `gateway` | `index` | `mongo` | `shkeeper` | `sso`

```ts
import { start, stop, type EthernaServiceName } from "@etherna/docker"

const session = await start({
  // Service enable/config options match today’s plugin service fields
  gateway: true,
  detached: true,
  portless: false,
  appPort: 5173, // optional; CLI / Vite supply when known
  // Vite-only: `enabled` (skip startup) and SSL cert injection stay in the plugin
})

await session.shutdown()

await stop("gateway")
await stop(["mongo", "sso"])
```

**`start`:**

- Resolve enabled services and their dependencies
- Ensure Docker is ready
- Run the dependency tree (including portless setup when requested)
- Own detached vs attached behavior (reuse running containers, whether to stop on exit, process-group isolation for `docker run`)
- Install SIGINT/SIGTERM handlers by default (`installSignalHandlers: true`); tests may disable
- Return `{ shutdown }` that performs session cleanup using the same rules as today’s Vite plugin / CLI

**`stop`:**

- Accept a typesafe logical service name or array of names
- Stop only those named groups’ containers (`bee` → bee node group; `shkeeper` → full stack; `blockchain` → blockchain container only)
- No upstream/downstream cascade
- Independent of detached mode (always stops the requested containers)

**CLI:**

- Thin argv parser over the same API
- `etherna start [services…] [flags]` — preserve current flags (`--detached` / `--attached`, `--portless`, `--app-port`); detached remains the CLI default
- `etherna stop [services…]` — new; same `EthernaServiceName` list (no `all` shorthand required for v1; if added, it means every logical service)
- `etherna help`

## Vite plugin integration

`etherna()` remains Vite-only. Flow:

1. **`config`** — merge Vite `.env` keys with prefixes `ETHERNA_` / `PORTLESS_` into `process.env`
2. **`configResolved`** — SSL cert injection when HTTPS requested; default app port
3. **`configureServer`** — if `enabled === false`, skip startup; else on `listening`:

```ts
const { shutdown } = await start({
  ...options,
  appPort: getDevServerPort(server, fallback),
})
// Persist shutdown; invoke on httpServer "close" and hard failure paths
```

The plugin must not build the dependency tree or call per-service starters. Portless, dependency order, detached reuse, and process tracking live inside docker `start`.

### Exports (hard break)

**From `@etherna/vite-plugin`:**

- `etherna`
- `defineEthernaPlugin`
- Vite helpers only: `getDevServerPort`, `applyEthernaPluginHttpsFallback`
- Plugin options type: docker `StartOptions` plus Vite-only fields (`enabled`, `https` for cert injection)

**From `@etherna/docker`:**

- `start`, `stop`
- Service/option/env types needed by those APIs
- CLI entry
- Additional exports only if required by the Vite package implementation (keep the public surface minimal)

Consumers that imported orchestration helpers/types from `@etherna/vite-plugin` must switch to `@etherna/docker`.

Workspace dependency: vite-plugin depends on `@etherna/docker` via `workspace:*` (or equivalent), published as the matching semver.

## Error handling & shutdown semantics

Preserve current behavior; ownership moves to Session / ServiceManager:

| Case | Behavior |
|------|----------|
| Startup failure with `onFailure: "stop"` (default) | Stop Docker containers for all enabled services in that run, then session shutdown (kill tracked spawns; portless cleanup per detached rules) |
| `session.shutdown()` while **attached** | Stop enabled containers + kill tracked spawns + portless cleanup |
| `session.shutdown()` while **detached** | Do not stop reused/started containers; do not stop portless proxy; may still kill session-local tracked procs if any |
| Ctrl+C / SIGINT during blockchain bootstrap | Wait for safe point; second signal forces exit |
| `stop(names)` | Always stop named logical groups’ containers; no dep cascade |
| Docker not ready | Fail fast before starting anything |
| Portless CLI missing / proxy failure | Fail fast |

Signal-handler cleanup logic lives in docker. Both CLI and Vite use `start`’s default signal handlers; real cleanup always goes through session `shutdown`.

## Testing

Move tests with ownership; add coverage for the new public surface.

| Package | Tests |
|---------|--------|
| `@etherna/docker` | Move applicable: `cli`, `docker`, `dependencies-tree`, `envs`, `portless`, `utils`. **Add:** `start` / `stop` / `shutdown` (detached vs attached), logical-group stop (`bee` / `shkeeper`), CLI `stop` |
| `@etherna/vite-plugin` | Slim plugin wiring tests; mock `@etherna/docker` so the plugin asserts it calls `start` / `shutdown` rather than re-testing containers |

Root `pnpm test` runs both packages. Prefer unit tests with mocked `docker` / `spawn`. Live Docker in CI is not required unless already relied upon.

## Publish workflow

Triggered on tag `v*` (example: `v1.7.0`):

1. Install, test, and build both workspace packages
2. **Prepublish version gate** — fail the job if any check fails:
   - Tag matches `v<semver>`
   - `packages/docker/package.json` `version` === `<semver>`
   - `packages/vite-plugin/package.json` `version` === `<semver>`
   - Both package versions equal each other
3. Publish both packages to npm (same public access / OIDC approach as today)
4. Create GitHub release (existing release-notes flow)

Root package is private and not published.

Release process: set **both** package versions to the same value, then create tag `v<that-version>`.

A small shared script (e.g. `scripts/check-release-versions.mjs`) should implement the gate for CI and local use.

## Migration notes (consumers)

- Install `@etherna/vite-plugin@1.7.0` as today for Vite usage; `@etherna/docker` comes in as a dependency
- For Node/CLI-only usage, depend on `@etherna/docker` directly
- Import `start` / `stop` / shared types from `@etherna/docker`
- `etherna stop <service…>` is new; `etherna start` behavior remains conceptually the same
- Breaking: non-plugin exports removed from `@etherna/vite-plugin`

## Success criteria

- Two packages publish at identical version `1.7.0` from one tag
- Version gate blocks publish when tag and either package.json disagree
- Vite plugin starts and shuts down via docker `start` / `shutdown` only
- CLI `start` and `stop` work through the same ServiceManager path
- Detached/attached semantics match current behavior
- Tests cover both packages and the new APIs

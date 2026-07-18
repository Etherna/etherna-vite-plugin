# Etherna Vite Plugin

Run all the Etherna services in your app locally, from a Vite plugin, from plain Node, or from the
command line.

This repository is a pnpm monorepo with two published packages:

- [`@etherna/docker`](./packages/docker) — orchestrates the Etherna Docker services (start/stop,
  dependency graph, Portless integration, SSL trust) from Node and from the `etherna` CLI. No Vite
  dependency.
- [`@etherna/vite-plugin`](./packages/vite-plugin) — a thin Vite plugin that starts services on
  `listening` and stops them on `close`, using `@etherna/docker` under the hood.

## Installation

### With Vite

```bash
npm install @etherna/vite-plugin
# or
yarn add @etherna/vite-plugin
# or
pnpm add @etherna/vite-plugin
```

`@etherna/vite-plugin` depends on `@etherna/docker`, so it's pulled in automatically — you don't
need to install it separately.

### Node / CLI only (no Vite)

If you just need to start/stop services from a script, another dev-server plugin, or the terminal,
install `@etherna/docker` directly:

```bash
npm install @etherna/docker
# or
pnpm add @etherna/docker
```

This gives you the `import { start, stop } from "@etherna/docker"` API and the `etherna` CLI binary
(exposed via `pnpm exec etherna`, `npx etherna`, etc.).

### Prerequisites

- Make sure [docker](https://www.docker.com/) is installed and running.

## `@etherna/vite-plugin`

```ts
// vite.config.ts
import { defineConfig } from "vite"
import { etherna } from "@etherna/vite-plugin"

export default defineConfig({
  plugins: [
    // ...
    etherna(),
  ],
})
```

Plugin options are the same `StartOptions` accepted by `@etherna/docker`'s `start()` (see below),
plus two Vite-only fields: `enabled` and `https`.

#### Opt out from services

```ts
// ...
  etherna({
    mongo: false,
    bee: false,
  }),
// ...
```

#### Custom service options

```ts
// ...
  etherna({
    mongo: true,
    gateway: {
      enabled: true,
      env: {
        "Bee:DirectUrl": "http://localhost:16633",
        "Bee:CachedUrl": "http://localhost:16633",
      },
    },
  }),
// ...
```

#### SHKeeper (Docker-only ETH profile)

`shkeeper` is opt-in and currently targets a Docker-only `ETH` setup.

- use `githubRepo` prop to build shkeeper or ethereum-shkeeper from a custom repository
- using `githubRepo: "mattiaz9/ethereum-shkeeper"` fork allows to use the integrated Ethereum RPC
  out of the box

```ts
// vite.config.ts
import { defineConfig } from "vite"
import { etherna } from "@etherna/vite-plugin"

export default defineConfig({
  plugins: [
    etherna({
      shkeeper: {
        ethereum: {
          githubRepo: "mattiaz9/ethereum-shkeeper",
        },
      },
    }),
  ],
})
```

Or use the defaults shorthand:

```ts
etherna({
  shkeeper: true,
})
```

### Disable all containers

```ts
// ...
  etherna({
    enabled: false,
  }),
// ...
```

This will skip the container startup and use the existing containers.

Useful when you want to run the containers separately (e.g. via the `etherna` CLI, see below).

## `@etherna/docker`

`@etherna/docker` owns all service orchestration: the dependency graph, container lifecycle,
Portless integration, and SSL trust helpers. `@etherna/vite-plugin` is a thin wrapper around it.

### `start` / `stop` from Node

```ts
import { start, stop } from "@etherna/docker"

// Start the default services (same dependency graph as the Vite plugin) and get a handle back.
const session = await start({
  mongo: true,
  gateway: { enabled: true },
})

// ... later, tear everything down (stops containers unless running detached):
await session.shutdown()
```

`start(options?: StartOptions)` resolves to an `EthernaSessionHandle` (`{ shutdown }`). `options`
lets you toggle each service (`elastic`, `mongo`, `bee`, `sso`, `index`, `gateway`, `credit`,
`beehive`, `shkeeper`), set `detached`, `portless`, `appPort`, `mode` (`"http" | "https"`), and
`installSignalHandlers`. See `packages/docker/src/types.ts` for the full `StartOptions` /
per-service env types (`BeeEnv`, `SsoEnv`, `GatewayEnv`, etc.), all re-exported from the package.

`stop(services: EthernaServiceName | EthernaServiceName[])` stops the Docker container group(s) for
the given logical service name(s) directly, without starting anything:

```ts
import { stop } from "@etherna/docker"

await stop("gateway")
await stop(["mongo", "sso"])
await stop("bee") // stops the whole bee node group (blockchain + bee nodes)
```

Valid service names: `blockchain`, `bee`, `beehive`, `credit`, `elastic`, `gateway`, `index`,
`mongo`, `shkeeper`, `sso`. Unknown names throw a `TypeError`.

### CLI

The `etherna` binary (installed with `@etherna/docker`, and re-exposed transitively when you only
depend on `@etherna/vite-plugin`) starts and stops services without running Vite at all:

```bash
pnpm exec etherna start sso gateway
```

The CLI starts the requested services plus their dependencies. For example, `gateway` also starts
MongoDB, SSO, Beehive, Bee, and the local blockchain. CLI startup is **detached by default**, so it
reuses already-running Etherna containers and leaves them running after the command exits.

Pass options directly on the command line:

```bash
pnpm exec etherna start sso gateway --portless --app-port 5173
```

Use `--portless` to start the Portless proxy and register aliases, `--app-port <port>` to set the
app URL used by SSO client configuration, and `--attached` if you want the CLI to track Docker
processes for the current session (containers are stopped when the process exits).

Stop one or more services directly, without starting anything:

```bash
pnpm exec etherna stop mongo sso
pnpm exec etherna stop all
```

`etherna stop` requires at least one service (or `all`, which stops every logical service group,
including `shkeeper`). Run `pnpm exec etherna --help` for the full option list.

### Detached services (optional)

When **detached** mode is on, `start()` **reuses already-running** Docker containers for enabled
services, **starts only missing** ones, and **does not stop** those containers when the session is
shut down. **Portless** aliases and the proxy process are **left running** as well (including when
this session started the proxy), so local `*.localhost` routes stay registered. `docker run` is
started in its own session so **Ctrl+C does not deliver SIGINT to the Docker CLI** (which would
otherwise tear down `--rm` containers that share the terminal's process group).

Configure it via `start()`/plugin options:

```ts
etherna({
  detached: true,
})
```

Or set the environment variable (used when `detached` is not set explicitly):

```bash
ETHERNA_DETACHED=1 vite
# or
ETHERNA_DETACHED=true pnpm dev
```

An explicit `detached: true | false` always wins over `ETHERNA_DETACHED`. The `etherna` CLI defaults
`start` to detached regardless of the environment variable; pass `--attached` to opt out.

If startup fails for a service (all services use `onFailure: "stop"` in the dependency graph),
`start()` **stops Docker containers for all enabled services**, including ones that were already
running before this run, then cleans up tracked client processes.

**Note:** Vite does not allow arbitrary CLI flags such as `vite --detached`; use the plugin option
or `ETHERNA_DETACHED` instead.

### Portless (optional)

When [portless](https://portless.sh/) is installed, you can opt in to friendly local URLs on the
default HTTP proxy port (`1355`). `start()` starts the Portless proxy (if needed), registers aliases
for the app and each enabled HTTP service, and sets **browser-facing** OIDC client redirect base
URLs to the Portless hostnames (e.g. `http://sso.localhost:1355` for client registrations).
**Authority and server-to-server URLs** (SSO authority, gateway/Beehive API bases used by backends)
stay on `http://localhost:<port>` so services inside Docker can resolve them; `*.localhost` names
often fail with "Name or service not known" in containers.

```bash
npm install -g portless
```

```ts
// vite.config.ts
import { defineConfig } from "vite"
import { etherna } from "@etherna/vite-plugin"

export default defineConfig({
  plugins: [
    etherna({
      portless: true,
    }),
  ],
})
```

Requires the `portless` CLI on your `PATH`. Portless integration is HTTP-only (the HTTPS path is not
supported yet).

## Breaking changes (1.7.0)

Prior to `1.7.0`, this repository published a single `@etherna/vite-plugin` package containing all
orchestration logic. As of `1.7.0`:

- **All orchestration types and helpers moved to the new `@etherna/docker` package.** This includes
  `EthernaServiceName`, `StartOptions`, `EthernaSessionHandle`, per-service env types (`BeeEnv`,
  `SsoEnv`, `GatewayEnv`, `IndexEnv`, `CreditEnv`, `BeehiveEnv`, `ElasticEnv`, `MongoEnv`,
  `ShkeeperEnv`, `ShkeeperEthereumEnv`, `AspServiceEnv`), `ShkeeperConfig` and related build/config
  types, `start`, `stop`, `ETHERNA_DETACHED_ENV`, and `resolveDetachedMode`. Import them from
  `@etherna/docker` instead of `@etherna/vite-plugin`.
- **`@etherna/vite-plugin` now only exports Vite-specific surface:** `etherna`,
  `EthernaPluginOptions`, `defineEthernaPlugin`, `getDevServerPort`, and
  `applyEthernaPluginHttpsFallback`. It no longer re-exports docker orchestration APIs.
- **New `etherna stop` CLI command** (previously only `start` existed).
- `@etherna/vite-plugin` now depends on `@etherna/docker` as a regular dependency (`workspace:*` in
  this repo, a matching published version once released).

Both packages are versioned and published together (same version number, e.g. `1.7.0`).

## Contributing / development

This is a pnpm workspace:

```bash
pnpm install
pnpm typecheck   # runs in each package
pnpm test        # runs in each package
pnpm build       # runs in each package
```

See `packages/docker` and `packages/vite-plugin` for package-specific source layout.

# Etherna Vite Plugin

Run all the Etherna services in your vite app locally.

## Installation

```bash
npm install @etherna/vite-plugin
// or
yarn add @etherna/vite-plugin
// or
pnpm add @etherna/vite-plugin
```

## Usage

### Prerequisites

- Make sure [docker](https://www.docker.com/) is installed and running.

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

`shkeeper` is opt-in and currently targets a Docker-only `ETH` setup:

- if the core `shkeeper.io` image is missing, the plugin fetches the latest upstream release source,
  builds it locally, and removes the temporary source tree after a successful build
- the plugin starts `shkeeper`, `ethereum-shkeeper`, `ethereum-tasks`, Redis, and MariaDB
- it reuses your existing Ethereum RPC instead of starting a fullnode

```ts
// vite.config.ts
import { defineConfig } from "vite"
import { etherna } from "@etherna/vite-plugin"

export default defineConfig({
  plugins: [
    etherna({
      shkeeper: {
        ethereum: {
          env: {
            FULLNODE_URL: "http://localhost:8545",
          },
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

Notes:

- `shkeeper` is disabled by default.
- `shkeeper: true` enables SHKeeper with the default image/build/env settings.
- On first run, the plugin builds the local image as `etherna/shkeeper:local` if it is missing.
- The default source path uses the latest SHKeeper GitHub release tag. It first tries the release
  archive download and falls back to cloning that exact tag if archive extraction is unavailable.
- `shkeeper.build.contextPath` is optional and acts as a local-source override when you want to
  build from a checkout or fork instead of the fetched latest release.
- The SHKeeper UI is exposed on `http://localhost:32650`.
- The SHKeeper containers use host-network-friendly `localhost` addresses for Redis, MariaDB, the
  sidecar, and the ETH RPC.
- The first supported profile is `ETH` only. ERC-20 variants such as `ETH-USDT` and `ETH-USDC` are
  not wired yet.
- `ethereum-shkeeper` defaults to `CURRENT_ETH_NETWORK=sepolia`. Override it in
  `shkeeper.ethereum.env` if your external RPC targets a different network.
- If the auto-fetched source build fails, the temporary source tree is left in the cache directory
  so you can inspect it.

### Disable all containers

```ts
// ...
  etherna({
    enabled: false,
  }),
// ...
```

This will skip the container startup and use the existing containers.

Useful when you want to run the containers separately.

### Portless (optional)

When [portless](https://portless.sh/) is installed, you can opt in to friendly local URLs on the
default HTTP proxy port (`1355`). The plugin starts the Portless proxy (if needed), registers
aliases for the Vite app and each enabled HTTP service, and sets **browser-facing** OIDC client
redirect base URLs to the Portless hostnames (e.g. `http://sso.localhost:1355` for client
registrations). **Authority and server-to-server URLs** (SSO authority, gateway/Beehive API bases
used by backends) stay on `http://localhost:<port>` so services inside Docker can resolve them;
`*.localhost` names often fail with “Name or service not known” in containers.

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

Requires the `portless` CLI on your `PATH`. Portless integration is HTTP-only (the plugin’s HTTPS
path is not supported yet).

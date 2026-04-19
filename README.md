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

`shkeeper` is opt-in and currently targets a Docker-only `ETH` setup.

- use `githubRepo` prop to build shkeeper or ethereum-shkeeper from a custom repository
- using `githubRepo: "mattiaz9/ethereum-shkeeper"` fork allows to use the integrated Ethereum RPC out of the box

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

Useful when you want to run the containers separately.

### Detached services (optional)

When **detached** mode is on, the plugin **reuses already-running** Docker containers for enabled services, **starts only missing** ones, and **does not stop** those containers when you stop the Vite dev server (Portless aliases/proxy started for this session are still cleaned up). `docker run` is started in its own session so **Ctrl+C does not deliver SIGINT to the Docker CLI** (which would otherwise tear down `--rm` containers that share the terminal’s process group).

Configure it in `vite.config.ts`:

```ts
etherna({
  detached: true,
})
```

Or set the environment variable (used when `detached` is not set on the plugin options):

```bash
ETHERNA_DETACHED=1 vite
# or
ETHERNA_DETACHED=true pnpm dev
```

An explicit `detached: true | false` in options always wins over `ETHERNA_DETACHED`.

If startup fails for a service with `onFailure: "stop"` (the default for the dependency tree), the plugin **stops Docker containers for all enabled services**, including ones that were already running before this run, then cleans up tracked client processes.

**Note:** Vite does not allow arbitrary CLI flags such as `vite --detached`; use the plugin option or `ETHERNA_DETACHED` instead.

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

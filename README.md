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

When [portless](https://portless.sh/) is installed, you can opt in to friendly local URLs on the default HTTP proxy port (`1355`). The plugin starts the Portless proxy (if needed), registers aliases for the Vite app and each enabled HTTP service, and sets **browser-facing** OIDC client redirect base URLs to the Portless hostnames (e.g. `http://sso.localhost:1355` for client registrations). **Authority and server-to-server URLs** (SSO authority, gateway/Beehive API bases used by backends) stay on `http://localhost:<port>` so services inside Docker can resolve them; `*.localhost` names often fail with “Name or service not known” in containers.

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

Requires the `portless` CLI on your `PATH`. Portless integration is HTTP-only (the plugin’s HTTPS path is not supported yet).

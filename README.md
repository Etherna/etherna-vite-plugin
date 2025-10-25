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

* Make sure [docker](https://www.docker.com/) is installed and running.

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { etherna } from '@etherna/vite-plugin'

export default defineConfig({
  plugins: [
    // ...
    etherna(),
  ],
})
```

Opt out from services

```ts
// ...
  etherna({
    mongo: false,
    bee: false,
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
# @etherna/docker

Orchestrate the Etherna Docker services (start/stop, dependency graph, Portless integration, SSL
trust) from Node or from the `etherna` CLI. No Vite dependency — use
[`@etherna/vite-plugin`](https://www.npmjs.com/package/@etherna/vite-plugin) instead if you're
running a Vite dev server.

See the [repository README](https://github.com/Etherna/etherna-vite-plugin#ethernadocker) for full
docs. Quick reference:

## Node

```ts
import { start, stop } from "@etherna/docker"

const session = await start({ mongo: true, gateway: { enabled: true } })
// ...
await session.shutdown()

await stop("gateway")
await stop(["mongo", "sso"])
```

## CLI

```bash
npm install -g @etherna/docker
# or: pnpm add @etherna/docker / npx etherna ...

etherna start sso gateway --portless --app-port 5173
etherna stop mongo sso
etherna --help
```

`etherna start` is detached by default (reuses/leaves running containers); pass `--attached` to stop
tracked containers when the process exits.

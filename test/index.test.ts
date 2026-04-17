import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type * as DockerModule from "../src/docker.ts"

const ensureDockerReadyMock = vi.fn(() => Promise.resolve())
const startShkeeperStackMock = vi.fn(() => Promise.resolve([]))

vi.mock("../src/docker.ts", async () => {
  const actual = await vi.importActual<typeof DockerModule>("../src/docker.ts")
  return {
    ...actual,
    ensureDockerReady: ensureDockerReadyMock,
    startShkeeperStack: startShkeeperStackMock,
  }
})

class FakeHttpServer extends EventEmitter {
  address() {
    return { port: 5173 }
  }
}

describe("etherna", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("treats `shkeeper: true` as enabled with default config", async () => {
    const { etherna } = await import("../src/index.ts")
    const plugin = etherna({
      elastic: false,
      mongo: false,
      bee: false,
      sso: false,
      index: false,
      gateway: false,
      credit: false,
      beehive: false,
      shkeeper: true,
    })
    const httpServer = new FakeHttpServer()
    const configureServer =
      typeof plugin.configureServer === "function"
        ? plugin.configureServer
        : plugin.configureServer?.handler

    await configureServer?.call(
      {} as never,
      {
        httpServer,
      } as never,
    )

    httpServer.emit("listening")
    await vi.waitFor(() => {
      expect(startShkeeperStackMock).toHaveBeenCalledWith({
        context: {
          mode: "http",
          portless: false,
          appPort: 5173,
        },
        build: {
          githubRepo: undefined,
          githubBranch: undefined,
          imageName: "vsyshost/shkeeper:2.5.12",
        },
        coreEnv: undefined,
        ethereumEnv: undefined,
        ethereumGithubRepo: undefined,
        ethereumGithubBranch: undefined,
      })
    })

    expect(ensureDockerReadyMock).toHaveBeenCalledTimes(1)
  })
})

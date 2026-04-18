import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type * as DockerModule from "../src/docker.ts"

const ensureDockerReadyMock = vi.fn(() => Promise.resolve())
const startShkeeperStackMock = vi.fn(() => Promise.resolve([]))
const startBlockchainMock = vi.fn(() => Promise.resolve({ kill: vi.fn() }))
const startBeeNodesMock = vi.fn(() => Promise.resolve([]))

let shutdownServicesSpy: ReturnType<typeof vi.fn> | undefined

vi.mock("../src/plugin-define.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugin-define.ts")>()
  return {
    ...actual,
    harnessEthernaPlugin: (options: Parameters<typeof actual.harnessEthernaPlugin>[0]) => {
      const h = actual.harnessEthernaPlugin(options)
      shutdownServicesSpy = vi.fn(h.shutdownServices)
      return { ...h, shutdownServices: shutdownServicesSpy }
    },
  }
})

vi.mock("../src/docker.ts", async () => {
  const actual = await vi.importActual<typeof DockerModule>("../src/docker.ts")
  return {
    ...actual,
    ensureDockerReady: ensureDockerReadyMock,
    startBlockchain: startBlockchainMock,
    startBeeNodes: startBeeNodesMock,
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
    startBlockchainMock.mockReset()
    startBlockchainMock.mockResolvedValue({ kill: vi.fn() })
    startBeeNodesMock.mockReset()
    startBeeNodesMock.mockResolvedValue([])
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

  it("starts bee blockchain before bee nodes", async () => {
    const { etherna } = await import("../src/index.ts")
    const plugin = etherna({
      bee: true,
      elastic: false,
      mongo: false,
      sso: false,
      index: false,
      gateway: false,
      credit: false,
      beehive: false,
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
      expect(startBeeNodesMock).toHaveBeenCalled()
    })

    expect(startBlockchainMock).toHaveBeenCalledTimes(1)
    expect(startBeeNodesMock).toHaveBeenCalledTimes(1)
    expect(startBlockchainMock.mock.invocationCallOrder[0]).toBeLessThan(
      startBeeNodesMock.mock.invocationCallOrder[0]!,
    )
  })

  it("calls shutdownServices when bee blockchain startup throws", async () => {
    startBlockchainMock.mockRejectedValueOnce(new Error("boom"))

    const { etherna } = await import("../src/index.ts")
    const plugin = etherna({
      bee: true,
      elastic: false,
      mongo: false,
      sso: false,
      index: false,
      gateway: false,
      credit: false,
      beehive: false,
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
      expect(shutdownServicesSpy).toHaveBeenCalledWith(false)
    })
  })
})

import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type * as DockerModule from "../src/docker.ts"
import type * as PluginDefineModule from "../src/plugin-define.ts"

const ensureDockerReadyMock = vi.fn(() => Promise.resolve())
const startShkeeperStackMock = vi.fn(() => Promise.resolve([]))
const startBlockchainMock = vi.fn(() => Promise.resolve({ kill: vi.fn() }))
const startBeeNodesMock = vi.fn(() => Promise.resolve([]))
const stopEnabledEthernaContainersMock = vi.fn(() => Promise.resolve())

let shutdownServicesSpy: ReturnType<typeof vi.fn> | undefined

vi.mock("../src/plugin-define.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof PluginDefineModule>()
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
    stopEnabledEthernaContainers: stopEnabledEthernaContainersMock,
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
        detached: false,
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
    const blockchainOrder = startBlockchainMock.mock.invocationCallOrder[0] ?? 0
    const beeNodesOrder = startBeeNodesMock.mock.invocationCallOrder[0] ?? 0
    expect(blockchainOrder).toBeTypeOf("number")
    expect(beeNodesOrder).toBeTypeOf("number")
    expect(blockchainOrder).toBeLessThan(beeNodesOrder)
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
      expect(stopEnabledEthernaContainersMock).toHaveBeenCalledWith({
        elastic: false,
        mongo: false,
        bee: true,
        sso: false,
        index: false,
        gateway: false,
        credit: false,
        beehive: false,
        shkeeper: false,
      })
      expect(shutdownServicesSpy).toHaveBeenCalledWith(false, false, {
        killTrackedSpawns: true,
      })
    })
  })

  it("on dev server close uses session shutdown without forcing tracked spawn kill when detached", async () => {
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
      detached: true,
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
      expect(startBlockchainMock).toHaveBeenCalled()
    })

    httpServer.emit("close")
    await vi.waitFor(() => {
      expect(shutdownServicesSpy).toHaveBeenCalledWith(false)
    })
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"

import type * as DockerRuntime from "../src/runtime/docker.ts"
import type * as BeeService from "../src/services/bee.ts"

const hoisted = vi.hoisted(() => ({
  killSpy: vi.fn(),
}))

vi.mock("../src/runtime/docker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof DockerRuntime>()
  return {
    ...actual,
    stopContainer: vi.fn(async () => {}),
    ensureDockerReady: vi.fn(async () => {}),
  }
})

vi.mock("../src/services/mongo.ts", () => ({
  startMongo: vi.fn(() => Promise.resolve(null)),
}))

vi.mock("../src/services/elastic.ts", () => ({
  // Pushes a tracked spawn so tests can observe killTrackedSpawns behavior on shutdown.
  startElastic: vi.fn((ctx: { pushSpawn: (...p: unknown[]) => void }) => {
    const proc = { kill: hoisted.killSpy }
    ctx.pushSpawn(proc)
    return Promise.resolve(proc)
  }),
}))

vi.mock("../src/services/asp.ts", () => ({
  startAspContainer: vi.fn(() => Promise.resolve(null)),
}))

vi.mock("../src/services/bee.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof BeeService>()
  return {
    ...actual,
    startBlockchain: vi.fn(() => Promise.resolve(null)),
    startBeeNodes: vi.fn(() => Promise.resolve([])),
  }
})

vi.mock("../src/services/shkeeper.ts", () => ({
  startShkeeperStack: vi.fn(() => Promise.resolve([])),
}))

import { start } from "../src/manager.ts"
import { ensureDockerReady, stopContainer } from "../src/runtime/docker.ts"
import { startElastic } from "../src/services/elastic.ts"
import { startMongo } from "../src/services/mongo.ts"

const ALL_OFF = {
  mongo: false,
  elastic: false,
  bee: false,
  sso: false,
  index: false,
  gateway: false,
  credit: false,
  beehive: false,
  shkeeper: false,
} as const

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.ETHERNA_DETACHED
})

describe("start", () => {
  it("ensures docker is ready and runs only enabled service starters", async () => {
    await start({ ...ALL_OFF, mongo: true, installSignalHandlers: false })
    expect(ensureDockerReady).toHaveBeenCalledOnce()
    expect(startMongo).toHaveBeenCalledOnce()
    expect(startElastic).not.toHaveBeenCalled()
  })

  it("returns a handle whose shutdown is idempotent", async () => {
    const handle = await start({ ...ALL_OFF, mongo: true, installSignalHandlers: false })
    expect(typeof handle.shutdown).toBe("function")
    await handle.shutdown()
  })

  it("on startup failure stops enabled containers even in detached mode, then kills tracked spawns", async () => {
    vi.mocked(startMongo).mockRejectedValueOnce(new Error("mongo boom"))

    await start({
      ...ALL_OFF,
      mongo: true,
      elastic: true,
      detached: true,
      installSignalHandlers: false,
    })

    // Explicit container stop for all enabled services must happen even when detached
    // (session.shutdown does not stop containers when detached).
    expect(stopContainer).toHaveBeenCalledWith("etherna-mongodb")
    expect(stopContainer).toHaveBeenCalledWith("etherna-elastic")
    // shutdown({ killTrackedSpawns: true }) tore down the tracked elastic spawn.
    expect(hoisted.killSpy).toHaveBeenCalled()
  })

  it("defaults detached to false when unset (plugin default); attached shutdown stops containers and kills spawns", async () => {
    const handle = await start({ ...ALL_OFF, elastic: true, installSignalHandlers: false })
    // No failure: nothing stopped yet.
    expect(stopContainer).not.toHaveBeenCalled()

    await handle.shutdown()

    // Attached (detached=false) shutdown stops enabled containers and kills tracked spawns by default.
    expect(stopContainer).toHaveBeenCalledWith("etherna-elastic")
    expect(hoisted.killSpy).toHaveBeenCalled()
  })
})

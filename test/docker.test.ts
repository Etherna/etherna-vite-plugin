import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

const spawnMock = vi.fn<(command: string, args?: string[]) => FakeChildProcess>()
const existsSyncMock = vi.fn(() => true)
const mkdirSyncMock = vi.fn()
const writeFileSyncMock = vi.fn()

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}))

vi.mock("node:fs", () => ({
  default: {
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    writeFileSync: writeFileSyncMock,
  },
}))

describe("startBlockchain", () => {
  let runProc: FakeChildProcess

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.resetModules()
    runProc = new FakeChildProcess()

    spawnMock.mockImplementation((_command, args) => {
      if (args?.[0] === "run") {
        return runProc
      }

      const proc = new FakeChildProcess()
      queueMicrotask(() => {
        proc.emit("close", 0)
      })
      return proc
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("waits for Bee contract bytecode before resolving blockchain startup", async () => {
    let fetchCalls = 0
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string }
      if (body.method === "eth_blockNumber") {
        return {
          ok: true,
          json: async () => ({ result: "0x4" }),
        }
      }

      fetchCalls += 1
      return {
        ok: true,
        json: async () => ({ result: fetchCalls <= 5 ? "0x" : "0x1234" }),
      }
    })
    vi.stubGlobal("fetch", fetchMock)

    const { startBlockchain } = await import("../src/docker.ts")

    let resolved = false
    const blockchainPromise = startBlockchain({ mode: "http", portless: false, appPort: 5173 })
      .then(() => {
        resolved = true
      })

    await vi.waitFor(() => {
      expect(runProc.stdout.listenerCount("data")).toBeGreaterThan(0)
    })
    runProc.stdout.emit("data", 'INFO HTTP server started endpoint="[::]:9545"')
    await vi.runAllTicks()

    expect(fetchMock).toHaveBeenCalled()
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(10_000)

    await blockchainPromise

    expect(resolved).toBe(true)
  })

  it("uses the default Bee contract addresses when no Bee env overrides are provided", async () => {
    const queriedAddresses: string[] = []
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string; params?: unknown[] }
      if (body.method === "eth_blockNumber") {
        return {
          ok: true,
          json: async () => ({ result: "0x4" }),
        }
      }

      queriedAddresses.push(String(body.params?.[0]))
      return {
        ok: true,
        json: async () => ({ result: "0x1234" }),
      }
    })
    vi.stubGlobal("fetch", fetchMock)

    const { startBlockchain } = await import("../src/docker.ts")

    const blockchainPromise = startBlockchain({ mode: "http", portless: false, appPort: 5173 })

    await vi.waitFor(() => {
      expect(runProc.stdout.listenerCount("data")).toBeGreaterThan(0)
    })
    runProc.stdout.emit("data", 'INFO HTTP server started endpoint="[::]:9545"')
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })

    expect(queriedAddresses).toContain("0xCfEB869F69431e42cdB54A4F4f105C19C080A601")
    expect(queriedAddresses).not.toContain("undefined")

    await blockchainPromise
  })

  it("rejects with recovery steps when a persisted blockchain has mined blocks but Bee contracts are still missing", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string }
      if (body.method === "eth_blockNumber") {
        return {
          ok: true,
          json: async () => ({ result: "0x25" }),
        }
      }

      return {
        ok: true,
        json: async () => ({ result: "0x" }),
      }
    })
    vi.stubGlobal("fetch", fetchMock)

    const { startBlockchain } = await import("../src/docker.ts")

    const blockchainPromise = startBlockchain({ mode: "http", portless: false, appPort: 5173 })

    await vi.waitFor(() => {
      expect(runProc.stdout.listenerCount("data")).toBeGreaterThan(0)
    })
    runProc.stdout.emit("data", 'INFO HTTP server started endpoint="[::]:9545"')

    await expect(blockchainPromise).rejects.toThrow(/docker volume rm etherna_blockchain-volume/)
  })

  it("keeps blockchain shutdown unsafe until initialization settles", async () => {
    let fetchCalls = 0
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string }
      if (body.method === "eth_blockNumber") {
        return {
          ok: true,
          json: async () => ({ result: "0x4" }),
        }
      }

      fetchCalls += 1
      return {
        ok: true,
        json: async () => ({ result: fetchCalls <= 5 ? "0x" : "0x1234" }),
      }
    })
    vi.stubGlobal("fetch", fetchMock)

    const { isBlockchainBootstrapInProgress, startBlockchain, waitForBlockchainBootstrapToSettle } =
      await import("../src/docker.ts")

    const blockchainPromise = startBlockchain({ mode: "http", portless: false, appPort: 5173 })
    let safeToStop = false
    const waitForSettlePromise = waitForBlockchainBootstrapToSettle().then(() => {
      safeToStop = true
    })

    expect(isBlockchainBootstrapInProgress()).toBe(true)
    expect(safeToStop).toBe(false)

    await vi.waitFor(() => {
      expect(runProc.stdout.listenerCount("data")).toBeGreaterThan(0)
    })
    runProc.stdout.emit("data", 'INFO HTTP server started endpoint="[::]:9545"')
    await vi.runAllTicks()

    expect(isBlockchainBootstrapInProgress()).toBe(true)
    expect(safeToStop).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    await blockchainPromise
    await waitForSettlePromise

    expect(isBlockchainBootstrapInProgress()).toBe(false)
    expect(safeToStop).toBe(true)
  })
})

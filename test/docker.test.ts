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
const readdirSyncMock = vi.fn<() => string[]>(() => [])
const rmSyncMock = vi.fn()

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}))

vi.mock("node:fs", () => ({
  default: {
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    readdirSync: readdirSyncMock,
    rmSync: rmSyncMock,
    writeFileSync: vi.fn(),
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

function parseJsonRpcBody(init?: RequestInit) {
  return JSON.parse((init?.body as string | undefined) ?? "{}") as {
    method?: string
    params?: unknown[]
  }
}

function jsonRpcResult(result: string) {
  return {
    ok: true,
    json: () => Promise.resolve({ result }),
  }
}

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
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = parseJsonRpcBody(init)
      if (body.method === "eth_blockNumber") {
        return Promise.resolve(jsonRpcResult("0x4"))
      }

      fetchCalls += 1
      return Promise.resolve(jsonRpcResult(fetchCalls <= 5 ? "0x" : "0x1234"))
    })
    vi.stubGlobal("fetch", fetchMock)

    const { startBlockchain } = await import("../src/docker.ts")

    let resolved = false
    const blockchainPromise = startBlockchain({
      mode: "http",
      portless: false,
      appPort: 5173,
    }).then(() => {
      resolved = true
    })

    await vi.waitFor(() => {
      expect(runProc.stdout.listenerCount("data")).toBeGreaterThan(0)
    })
    runProc.stdout.emit("data", 'INFO HTTP server started endpoint="[::]:9545"')
    vi.runAllTicks()

    expect(fetchMock).toHaveBeenCalled()
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(10_000)

    await blockchainPromise

    expect(resolved).toBe(true)
  })

  it("uses the default Bee contract addresses when no Bee env overrides are provided", async () => {
    const queriedAddresses: string[] = []
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = parseJsonRpcBody(init)
      if (body.method === "eth_blockNumber") {
        return Promise.resolve(jsonRpcResult("0x4"))
      }

      queriedAddresses.push(String(body.params?.[0]))
      return Promise.resolve(jsonRpcResult("0x1234"))
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
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = parseJsonRpcBody(init)
      if (body.method === "eth_blockNumber") {
        return Promise.resolve(jsonRpcResult("0x25"))
      }

      return Promise.resolve(jsonRpcResult("0x"))
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
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = parseJsonRpcBody(init)
      if (body.method === "eth_blockNumber") {
        return Promise.resolve(jsonRpcResult("0x4"))
      }

      fetchCalls += 1
      return Promise.resolve(jsonRpcResult(fetchCalls <= 5 ? "0x" : "0x1234"))
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
    vi.runAllTicks()

    expect(isBlockchainBootstrapInProgress()).toBe(true)
    expect(safeToStop).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    await blockchainPromise
    await waitForSettlePromise

    expect(isBlockchainBootstrapInProgress()).toBe(false)
    expect(safeToStop).toBe(true)
  })
})

describe("ensureDockerImageFromGitHub", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    readdirSyncMock.mockReturnValue([])
    spawnMock.mockImplementation((_command, _args) => {
      const proc = new FakeChildProcess()
      queueMicrotask(() => {
        proc.emit("close", 0)
      })
      return proc
    })
  })

  it("does not log when the image already exists", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const { ensureDockerImageFromGitHub } = await import("../src/builder.ts")

    await ensureDockerImageFromGitHub({
      logLabel: "shkeeper",
      imageName: "etherna/shkeeper:local",
      sourceRepo: "vsys-host/shkeeper.io",
      workspacePrefix: ".shkeeper-build",
      gitRef: "2.5.12",
    })

    expect(consoleLogSpy).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it("clones the pinned git ref, builds, and cleans up the temp source", async () => {
    spawnMock.mockImplementation((_command, args) => {
      const proc = new FakeChildProcess()
      queueMicrotask(() => {
        proc.emit("close", args?.[0] === "image" ? 1 : 0)
      })
      return proc
    })

    const { ensureDockerImageFromGitHub } = await import("../src/builder.ts")

    await ensureDockerImageFromGitHub({
      logLabel: "shkeeper",
      imageName: "etherna/shkeeper:local",
      sourceRepo: "vsys-host/shkeeper.io",
      workspacePrefix: ".shkeeper-build",
      gitRef: "2.5.12",
    })

    expect(spawnMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "clone",
        "--depth",
        "1",
        "--branch",
        "2.5.12",
        "https://github.com/vsys-host/shkeeper.io.git",
      ]),
    )
    expect(spawnMock).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "build",
        "-t",
        "etherna/shkeeper:local",
        "-f",
        expect.stringContaining("/clone/Dockerfile"),
        expect.stringContaining("/clone"),
      ]),
    )
    expect(rmSyncMock).toHaveBeenCalledWith(expect.stringContaining(".shkeeper-build"), {
      force: true,
      recursive: true,
    })
  })

  it("preserves the cloned source and reports its path when the build fails", async () => {
    spawnMock.mockImplementation((_command, args) => {
      const proc = new FakeChildProcess()
      queueMicrotask(() => {
        const code = args?.[0] === "image" || args?.[0] === "build" ? 1 : 0
        proc.emit("close", code)
      })
      return proc
    })

    const { ensureDockerImageFromGitHub } = await import("../src/builder.ts")

    await expect(
      ensureDockerImageFromGitHub({
        logLabel: "shkeeper",
        imageName: "etherna/shkeeper:local",
        sourceRepo: "vsys-host/shkeeper.io",
        workspacePrefix: ".shkeeper-build",
        gitRef: "2.5.12",
      }),
    ).rejects.toThrow(/Inspect cloned source at/)
    expect(rmSyncMock).not.toHaveBeenCalled()
  })
})

describe("startShkeeperCoreContainer", () => {
  let runProc: FakeChildProcess

  beforeEach(() => {
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

  it("starts shkeeper on the bridge network with localhost service discovery", async () => {
    const { startShkeeperCoreContainer } = await import("../src/docker.ts")

    const startPromise = startShkeeperCoreContainer({
      context: { mode: "http", portless: false, appPort: 5173 },
      build: {
        imageName: "etherna/shkeeper:local",
      },
      networkName: "etherna_shkeeper_network",
    })

    await vi.waitFor(() => {
      expect(runProc.stdout.listenerCount("data")).toBeGreaterThan(0)
    })
    runProc.stdout.emit(
      "data",
      "[2026-01-01 00:00:00 +0000] [1] [INFO] Listening at: http://0.0.0.0:5000",
    )

    await startPromise

    expect(spawnMock).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "run",
        "--rm",
        "--name",
        "shkeeper",
        "-p",
        "32650:5000",
        "--network",
        "etherna_shkeeper_network",
        "-e",
        "ETHEREUM_API_SERVER_HOST=localhost",
        "-e",
        "ETH_WALLET=enabled",
        "etherna/shkeeper:local",
      ]),
    )
  })

  it("starts shkeeper on the host network with localhost service discovery", async () => {
    const { startShkeeperCoreContainer } = await import("../src/docker.ts")

    const startPromise = startShkeeperCoreContainer({
      context: { mode: "http", portless: false, appPort: 5173 },
      build: {
        imageName: "etherna/shkeeper:local",
      },
      networkName: "host",
    })

    await vi.waitFor(() => {
      expect(runProc.stdout.listenerCount("data")).toBeGreaterThan(0)
    })
    runProc.stdout.emit(
      "data",
      "[2026-01-01 00:00:00 +0000] [1] [INFO] Listening at: http://0.0.0.0:32650",
    )

    await startPromise

    expect(spawnMock).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "run",
        "--rm",
        "--name",
        "shkeeper",
        "--network",
        "host",
        "-e",
        "ETHEREUM_API_SERVER_HOST=localhost",
        "etherna/shkeeper:local",
        "bash",
        "-c",
        "gunicorn --access-logfile=- --workers=1 --threads=16 --timeout=600 --bind=0.0.0.0:32650 'shkeeper:create_app()'",
      ]),
    )
    expect(spawnMock).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["-p", "32650:5000"]),
    )
  })
})

describe("startShkeeperEthereumApiContainer", () => {
  let runProc: FakeChildProcess

  beforeEach(() => {
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

  it("starts the ethereum sidecar with the upstream gunicorn command", async () => {
    const { startShkeeperEthereumApiContainer } = await import("../src/docker.ts")

    const startPromise = startShkeeperEthereumApiContainer({
      context: { mode: "http", portless: false, appPort: 5173 },
      networkName: "etherna_shkeeper_network",
      imageName: "vsyshost/ethereum-shkeeper:1.2.3",
    })

    await vi.waitFor(() => {
      expect(runProc.stdout.listenerCount("data")).toBeGreaterThan(0)
    })
    runProc.stdout.emit(
      "data",
      "[2026-01-01 00:00:00 +0000] [1] [INFO] Listening at: http://0.0.0.0:6000",
    )

    await startPromise

    const dockerRun = spawnMock.mock.calls.find(
      (call) => call[0] === "docker" && call[1]?.[0] === "run",
    )
    expect(dockerRun?.[1]).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "--name",
        "ethereum-shkeeper",
        "--network",
        "etherna_shkeeper_network",
        "-e",
        "FULLNODE_URL=http://localhost:9545",
        "-e",
        "CURRENT_ETH_NETWORK=custom",
        "-e",
        "REDIS_HOST=localhost",
        "vsyshost/ethereum-shkeeper:1.2.3",
        "bash",
        "-c",
        "sleep 30 && gunicorn --access-logfile=- --workers=1 --threads=16 --timeout=600 --bind=0.0.0.0:6000 run:server",
      ]),
    )
  })
})

describe("startShkeeperEthereumTasksContainer", () => {
  let runProc: FakeChildProcess

  beforeEach(() => {
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

  it("waits for the celery worker readiness log before resolving", async () => {
    const { startShkeeperEthereumTasksContainer } = await import("../src/docker.ts")

    let resolved = false
    const startPromise = startShkeeperEthereumTasksContainer({
      context: { mode: "http", portless: false, appPort: 5173 },
      networkName: "etherna_shkeeper_network",
      imageName: "vsyshost/ethereum-shkeeper:1.2.3",
    }).then(() => {
      resolved = true
    })

    await vi.waitFor(() => {
      expect(runProc.stdout.listenerCount("data")).toBeGreaterThan(0)
    })
    expect(resolved).toBe(false)

    runProc.stdout.emit("data", "[2026-01-01 00:00:00,000: INFO/MainProcess] celery@worker ready.")
    await startPromise

    expect(resolved).toBe(true)
    expect(spawnMock).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "run",
        "--rm",
        "--name",
        "ethereum-tasks",
        "-e",
        "C_FORCE_ROOT=1",
        "vsyshost/ethereum-shkeeper:1.2.3",
        "bash",
        "-c",
        "sleep 30 && celery -A celery_worker.celery worker --loglevel=info -B",
      ]),
    )
  })
})

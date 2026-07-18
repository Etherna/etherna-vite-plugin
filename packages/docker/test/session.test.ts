import { describe, expect, it, vi } from "vitest"

import { createSession } from "../src/session.ts"

function enabledMap(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    mongo: false,
    bee: false,
    sso: false,
    index: false,
    gateway: false,
    credit: false,
    beehive: false,
    elastic: false,
    shkeeper: false,
    ...overrides,
  }
}

describe("createSession", () => {
  it("shutdown in attached mode stops enabled containers and kills spawns", async () => {
    const stopContainers = vi.fn(async () => {})
    const kill = vi.fn()
    const session = createSession({
      detached: false,
      enabledServices: enabledMap({ mongo: true }),
      stopContainersForEnabled: stopContainers,
    })
    session.pushSpawn({ kill } as never)
    await session.shutdown()
    expect(stopContainers).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledOnce()
  })

  it("shutdown in detached mode does not stop containers", async () => {
    const stopContainers = vi.fn(async () => {})
    const session = createSession({
      detached: true,
      enabledServices: enabledMap({ mongo: true }),
      stopContainersForEnabled: stopContainers,
    })
    await session.shutdown()
    expect(stopContainers).not.toHaveBeenCalled()
  })

  it("shutdown in detached mode does not kill tracked spawns by default", async () => {
    const kill = vi.fn()
    const session = createSession({
      detached: true,
      enabledServices: enabledMap(),
      stopContainersForEnabled: vi.fn(async () => {}),
    })
    session.pushSpawn({ kill } as never)
    await session.shutdown()
    expect(kill).not.toHaveBeenCalled()
  })

  it("shutdown in detached mode kills tracked spawns when killTrackedSpawns is requested", async () => {
    const kill = vi.fn()
    const session = createSession({
      detached: true,
      enabledServices: enabledMap(),
      stopContainersForEnabled: vi.fn(async () => {}),
    })
    session.pushSpawn({ kill } as never)
    await session.shutdown({ killTrackedSpawns: true })
    expect(kill).toHaveBeenCalledOnce()
  })

  it("shutdown in detached mode does not stop containers even when killTrackedSpawns is requested", async () => {
    const stopContainers = vi.fn(async () => {})
    const session = createSession({
      detached: true,
      enabledServices: enabledMap({ mongo: true }),
      stopContainersForEnabled: stopContainers,
    })
    await session.shutdown({ killTrackedSpawns: true })
    expect(stopContainers).not.toHaveBeenCalled()
  })

  it("shutdown in detached mode does not stop the portless proxy", async () => {
    const stopPortlessProxy = vi.fn(async () => {})
    const session = createSession({
      detached: true,
      enabledServices: enabledMap(),
      stopContainersForEnabled: vi.fn(async () => {}),
      stopPortlessProxy,
    })
    session.setPortlessProxyStartedByUs(true)
    await session.shutdown()
    expect(stopPortlessProxy).not.toHaveBeenCalled()
  })

  it("shutdown in attached mode cleans up portless", async () => {
    const stopPortlessProxy = vi.fn(async () => {})
    const session = createSession({
      detached: false,
      enabledServices: enabledMap(),
      stopContainersForEnabled: vi.fn(async () => {}),
      stopPortlessProxy,
    })
    session.setPortlessProxyStartedByUs(true)
    await session.shutdown()
    expect(stopPortlessProxy).toHaveBeenCalledOnce()
  })

  it("marks shutdown as requested as soon as it is called", async () => {
    const session = createSession({
      detached: false,
      enabledServices: enabledMap(),
      stopContainersForEnabled: vi.fn(async () => {}),
    })
    expect(session.isShutdownRequested()).toBe(false)
    const promise = session.shutdown()
    expect(session.isShutdownRequested()).toBe(true)
    await promise
  })

  it("does not run shutdown work twice concurrently unless forced", async () => {
    const stopContainers = vi.fn(async () => {})
    const session = createSession({
      detached: false,
      enabledServices: enabledMap(),
      stopContainersForEnabled: stopContainers,
    })
    await Promise.all([session.shutdown(), session.shutdown()])
    expect(stopContainers).toHaveBeenCalledOnce()
  })

  it("re-runs shutdown work when force is set", async () => {
    const stopContainers = vi.fn(async () => {})
    const session = createSession({
      detached: false,
      enabledServices: enabledMap(),
      stopContainersForEnabled: stopContainers,
    })
    await session.shutdown()
    await session.shutdown({ force: true })
    expect(stopContainers).toHaveBeenCalledTimes(2)
  })

  it("waits for an in-progress blockchain bootstrap to settle before shutting down", async () => {
    let resolveSettle!: () => void
    const settle = new Promise<void>((resolve) => {
      resolveSettle = resolve
    })
    const stopContainers = vi.fn(async () => {})
    const session = createSession({
      detached: false,
      enabledServices: enabledMap(),
      stopContainersForEnabled: stopContainers,
      isBlockchainBootstrapInProgress: () => true,
      waitForBlockchainBootstrapToSettle: () => settle,
    })

    const promise = session.shutdown()
    await Promise.resolve()
    await Promise.resolve()
    expect(stopContainers).not.toHaveBeenCalled()

    resolveSettle()
    await promise
    expect(stopContainers).toHaveBeenCalledOnce()
  })

  it("skips waiting for blockchain bootstrap when force is set", async () => {
    const wait = vi.fn(async () => {})
    const stopContainers = vi.fn(async () => {})
    const session = createSession({
      detached: false,
      enabledServices: enabledMap(),
      stopContainersForEnabled: stopContainers,
      isBlockchainBootstrapInProgress: () => true,
      waitForBlockchainBootstrapToSettle: wait,
    })
    await session.shutdown({ force: true })
    expect(wait).not.toHaveBeenCalled()
    expect(stopContainers).toHaveBeenCalledOnce()
  })

  it("calls exitProcess when requested", async () => {
    const exitProcess = vi.fn()
    const session = createSession({
      detached: false,
      enabledServices: enabledMap(),
      stopContainersForEnabled: vi.fn(async () => {}),
      exitProcess,
    })
    await session.shutdown({ exitProcess: true })
    expect(exitProcess).toHaveBeenCalledWith(0)
  })

  it("does not call exitProcess by default", async () => {
    const exitProcess = vi.fn()
    const session = createSession({
      detached: false,
      enabledServices: enabledMap(),
      stopContainersForEnabled: vi.fn(async () => {}),
      exitProcess,
    })
    await session.shutdown()
    expect(exitProcess).not.toHaveBeenCalled()
  })

  it("installSignalHandlers registers SIGINT and SIGTERM handlers that trigger shutdown", async () => {
    const stopContainers = vi.fn(async () => {})
    const session = createSession({
      detached: false,
      enabledServices: enabledMap(),
      stopContainersForEnabled: stopContainers,
      exitProcess: vi.fn(),
    })

    const onSpy = vi.spyOn(process, "on").mockImplementation((() => process) as never)
    session.installSignalHandlers()
    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function))
    expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function))

    const sigintHandler = onSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1] as () => void
    const stdinResumeSpy = vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin)
    sigintHandler()
    await vi.waitFor(() => {
      expect(stopContainers).toHaveBeenCalledOnce()
    })
    expect(stdinResumeSpy).toHaveBeenCalledOnce()

    onSpy.mockRestore()
    stdinResumeSpy.mockRestore()
  })

  it("recordPortlessAlias registers the alias and cleanupPortless removes it", async () => {
    const addPortlessAlias = vi.fn(async () => {})
    const removePortlessAliases = vi.fn(async () => {})
    const stopPortlessProxy = vi.fn(async () => {})
    const session = createSession({
      detached: false,
      enabledServices: enabledMap(),
      stopContainersForEnabled: vi.fn(async () => {}),
      addPortlessAlias,
      removePortlessAliases,
      stopPortlessProxy,
    })

    await session.recordPortlessAlias("app", 3000)
    expect(addPortlessAlias).toHaveBeenCalledWith("app", 3000)

    session.setPortlessProxyStartedByUs(true)
    await session.shutdown()

    expect(removePortlessAliases).toHaveBeenCalledWith(["app"])
    expect(stopPortlessProxy).toHaveBeenCalledOnce()
  })
})

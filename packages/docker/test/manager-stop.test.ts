import { describe, expect, it, vi } from "vitest"

import type * as DockerRuntime from "../src/runtime/docker.ts"

vi.mock("../src/runtime/docker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof DockerRuntime>()
  return {
    ...actual,
    stopContainer: vi.fn(async () => {}),
    ensureDockerReady: vi.fn(async () => {}),
  }
})

import { stop } from "../src/manager.ts"
import { stopContainer } from "../src/runtime/docker.ts"

describe("stop", () => {
  it("stops only named logical groups", async () => {
    await stop(["mongo", "sso"])
    expect(stopContainer).toHaveBeenCalledWith("etherna-mongodb")
    expect(stopContainer).toHaveBeenCalledWith("etherna-sso")
    expect(stopContainer).not.toHaveBeenCalledWith("etherna-gateway")
  })

  it("stops the full bee group for bee", async () => {
    await stop("bee")
    expect(stopContainer).toHaveBeenCalledWith("etherna-blockchain")
    expect(stopContainer).toHaveBeenCalledWith("etherna-bee")
    expect(stopContainer).toHaveBeenCalledWith("etherna-bee_worker_1")
  })

  it("de-duplicates overlapping container names across services", async () => {
    vi.mocked(stopContainer).mockClear()
    // `bee` and `blockchain` both include etherna-blockchain; it must be stopped once.
    await stop(["bee", "blockchain"])
    const blockchainStops = vi
      .mocked(stopContainer)
      .mock.calls.filter(([name]) => name === "etherna-blockchain").length
    expect(blockchainStops).toBe(1)
  })

  it("throws a TypeError listing valid names for an unknown service", async () => {
    await expect(stop(["mongo", "nope" as never])).rejects.toBeInstanceOf(TypeError)
    await expect(stop("nope" as never)).rejects.toThrow(/mongo/)
  })
})

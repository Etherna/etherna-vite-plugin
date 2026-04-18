import { describe, expect, it, vi } from "vitest"

import {
  createDependenciesTree,
  DependencyTreeValidationError,
  validateDependencyTree,
} from "../src/dependencies-tree.ts"

function noopLogger() {
  return { logError: vi.fn() }
}

describe("validateDependencyTree", () => {
  it("rejects duplicate service codes", () => {
    expect(() =>
      validateDependencyTree([
        { code: "a", startupCallback: async () => true },
        { code: "a", startupCallback: async () => true },
      ]),
    ).toThrow(DependencyTreeValidationError)
    expect(() =>
      validateDependencyTree([
        { code: "a", startupCallback: async () => true },
        { code: "a", startupCallback: async () => true },
      ]),
    ).toThrow(/Duplicate service code/)
  })

  it("rejects unknown dependency references", () => {
    expect(() =>
      validateDependencyTree([
        { code: "a", dependencies: ["missing"], startupCallback: async () => true },
      ]),
    ).toThrow(/unknown service/)
  })

  it("rejects self-dependencies", () => {
    expect(() =>
      validateDependencyTree([
        { code: "a", dependencies: ["a"], startupCallback: async () => true },
      ]),
    ).toThrow(/cannot depend on itself/)
  })

  it("rejects cycles", () => {
    expect(() =>
      validateDependencyTree([
        { code: "a", dependencies: ["b"], startupCallback: async () => true },
        { code: "b", dependencies: ["a"], startupCallback: async () => true },
      ]),
    ).toThrow(/cycle/)
  })
})

describe("createDependenciesTree", () => {
  it("runs independent services concurrently", async () => {
    const order: string[] = []
    let releaseSlow!: () => void
    const deferred = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const tree = createDependenciesTree(
      [
        {
          code: "slow",
          startupCallback: async () => {
            order.push("slow-start")
            await deferred
            order.push("slow-end")
            return true
          },
        },
        {
          code: "fast",
          startupCallback: async () => {
            order.push("fast")
            return true
          },
        },
      ],
      noopLogger(),
    )

    const startPromise = tree.start()
    await vi.waitFor(() => {
      expect(order).toContain("slow-start")
      expect(order).toContain("fast")
    })
    releaseSlow!()
    await startPromise

    expect(order.indexOf("fast")).toBeLessThan(order.indexOf("slow-end"))
  })

  it("waits for dependencies before starting dependents", async () => {
    const order: string[] = []
    const tree = createDependenciesTree(
      [
        {
          code: "a",
          startupCallback: async () => {
            order.push("a")
            return true
          },
        },
        {
          code: "b",
          dependencies: ["a"],
          startupCallback: async () => {
            order.push("b")
            return true
          },
        },
      ],
      noopLogger(),
    )

    await tree.start()
    expect(order).toEqual(["a", "b"])
  })

  it("returns results in declaration order", async () => {
    const tree = createDependenciesTree(
      [
        {
          code: "b",
          dependencies: ["a"],
          startupCallback: async () => true,
        },
        { code: "a", startupCallback: async () => true },
      ],
      noopLogger(),
    )

    const { services } = await tree.start()
    expect(services.map((s) => s.code)).toEqual(["b", "a"])
  })

  it("blocks dependents when a dependency fails with onFailure log", async () => {
    const logger = noopLogger()
    const tree = createDependenciesTree(
      [
        {
          code: "a",
          onFailure: "log",
          startupCallback: async () => false,
        },
        {
          code: "b",
          dependencies: ["a"],
          startupCallback: async () => {
            throw new Error("should not run")
          },
        },
      ],
      logger,
    )

    const { shouldStop, services } = await tree.start()
    expect(shouldStop).toBe(false)
    expect(logger.logError).toHaveBeenCalledWith("a", "Service startup returned false")
    expect(services.find((s) => s.code === "a")?.status).toBe("failed")
    expect(services.find((s) => s.code === "b")?.status).toBe("blocked")
    expect(services.find((s) => s.code === "b")?.blockedBy).toContain("a")
  })

  it("sets shouldStop when onFailure is stop", async () => {
    const logger = noopLogger()
    const tree = createDependenciesTree(
      [
        {
          code: "a",
          onFailure: "stop",
          startupCallback: async () => {
            throw new Error("boom")
          },
        },
      ],
      logger,
    )

    const { shouldStop, services } = await tree.start()
    expect(shouldStop).toBe(true)
    expect(logger.logError).not.toHaveBeenCalled()
    expect(services[0]?.status).toBe("failed")
    expect(services[0]?.error?.message).toBe("boom")
  })

  it("does not set shouldStop for failed services with onFailure log", async () => {
    const logger = noopLogger()
    const tree = createDependenciesTree(
      [
        {
          code: "a",
          onFailure: "log",
          startupCallback: async () => {
            throw new Error("boom")
          },
        },
      ],
      logger,
    )

    const { shouldStop } = await tree.start()
    expect(shouldStop).toBe(false)
    expect(logger.logError).toHaveBeenCalledWith("a", "boom")
  })

  it("wraps non-Error throws", async () => {
    const tree = createDependenciesTree(
      [
        {
          code: "a",
          startupCallback: async () => {
            throw "stringy"
          },
        },
      ],
      noopLogger(),
    )

    const { services } = await tree.start()
    expect(services[0]?.error?.message).toBe("stringy")
  })

  it("runs diamond dependencies only after both parents complete", async () => {
    const order: string[] = []
    const tree = createDependenciesTree(
      [
        { code: "a", startupCallback: async () => (order.push("a"), true) },
        { code: "b", startupCallback: async () => (order.push("b"), true) },
        {
          code: "c",
          dependencies: ["a", "b"],
          startupCallback: async () => (order.push("c"), true),
        },
        {
          code: "d",
          dependencies: ["a", "b"],
          startupCallback: async () => (order.push("d"), true),
        },
      ],
      noopLogger(),
    )

    await tree.start()
    expect(order.filter((x) => x === "a" || x === "b").length).toBe(2)
    const iA = order.indexOf("a")
    const iB = order.indexOf("b")
    const iC = order.indexOf("c")
    const iD = order.indexOf("d")
    expect(Math.max(iA, iB)).toBeLessThan(Math.min(iC, iD))
  })

  it("skips startup when enabled is false", async () => {
    const cb = vi.fn(async () => true)
    const tree = createDependenciesTree(
      [{ code: "a", enabled: false, startupCallback: cb }],
      noopLogger(),
    )
    const { services } = await tree.start()
    expect(cb).not.toHaveBeenCalled()
    expect(services[0]?.status).toBe("skipped")
  })

  it("runs beforeStartup before startupCallback", async () => {
    const order: string[] = []
    const tree = createDependenciesTree(
      [
        {
          code: "a",
          beforeStartup: async () => {
            order.push("before-a")
          },
          startupCallback: async () => {
            order.push("a")
            return true
          },
        },
      ],
      noopLogger(),
    )
    await tree.start()
    expect(order).toEqual(["before-a", "a"])
  })

  it("treats disabled dependencies as satisfied for dependents", async () => {
    const order: string[] = []
    const tree = createDependenciesTree(
      [
        {
          code: "a",
          enabled: false,
          startupCallback: async () => {
            order.push("a")
            return true
          },
        },
        {
          code: "b",
          dependencies: ["a"],
          startupCallback: async () => {
            order.push("b")
            return true
          },
        },
      ],
      noopLogger(),
    )
    await tree.start()
    expect(order).toEqual(["b"])
  })
})

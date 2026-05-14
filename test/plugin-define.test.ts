import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ETHERNA_DETACHED_ENV,
  harnessEthernaPlugin,
  resolveDetachedMode,
} from "../src/plugin-define.ts"

import type * as PortlessModule from "../src/portless.ts"

const portlessMocks = vi.hoisted(() => ({
  addPortlessAlias: vi.fn(() => Promise.resolve()),
  removePortlessAliases: vi.fn((_names: string[]) => Promise.resolve()),
  stopPortlessProxy: vi.fn(() => Promise.resolve()),
}))

vi.mock("../src/portless.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof PortlessModule>()
  return {
    ...actual,
    addPortlessAlias: portlessMocks.addPortlessAlias,
    removePortlessAliases: portlessMocks.removePortlessAliases,
    stopPortlessProxy: portlessMocks.stopPortlessProxy,
  }
})

describe("resolveDetachedMode", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, ETHERNA_DETACHED_ENV)
  })

  it("uses explicit detached when set", () => {
    expect(resolveDetachedMode({ detached: true })).toBe(true)
    expect(resolveDetachedMode({ detached: false })).toBe(false)
  })

  it("reads env when detached is omitted", () => {
    process.env[ETHERNA_DETACHED_ENV] = "1"
    expect(resolveDetachedMode({})).toBe(true)

    process.env[ETHERNA_DETACHED_ENV] = "true"
    expect(resolveDetachedMode({})).toBe(true)

    process.env[ETHERNA_DETACHED_ENV] = "yes"
    expect(resolveDetachedMode({})).toBe(true)

    process.env[ETHERNA_DETACHED_ENV] = "0"
    expect(resolveDetachedMode({})).toBe(false)
  })

  it("explicit detached overrides env", () => {
    process.env[ETHERNA_DETACHED_ENV] = "1"
    expect(resolveDetachedMode({ detached: false })).toBe(false)
  })
})

describe("harnessEthernaPlugin portless cleanup", () => {
  afterEach(() => {
    vi.clearAllMocks()
    portlessMocks.addPortlessAlias.mockReset()
    portlessMocks.removePortlessAliases.mockReset()
    portlessMocks.stopPortlessProxy.mockReset()
    Reflect.deleteProperty(process.env, ETHERNA_DETACHED_ENV)
  })

  it("does not remove aliases or stop proxy on shutdown when detached", async () => {
    const h = harnessEthernaPlugin({ detached: true, portless: true })
    h.setPortlessProxyStartedByUs(true)
    await h.shutdownServices(false, false)
    expect(portlessMocks.removePortlessAliases).not.toHaveBeenCalled()
    expect(portlessMocks.stopPortlessProxy).not.toHaveBeenCalled()
  })

  it("does not clean up portless when detached is implied by env", async () => {
    process.env[ETHERNA_DETACHED_ENV] = "1"
    const h = harnessEthernaPlugin({ portless: true })
    h.setPortlessProxyStartedByUs(true)
    await h.shutdownServices(false, false)
    expect(portlessMocks.removePortlessAliases).not.toHaveBeenCalled()
    expect(portlessMocks.stopPortlessProxy).not.toHaveBeenCalled()
  })

  it("removes aliases and stops proxy on shutdown when not detached", async () => {
    const h = harnessEthernaPlugin({ detached: false, portless: true })
    h.setPortlessProxyStartedByUs(true)
    portlessMocks.removePortlessAliases.mockImplementationOnce((names: string[]) => {
      expect(names).toEqual(["bee"])
      return Promise.resolve()
    })
    await h.recordPortlessAlias("bee", 1633)
    await h.shutdownServices(false, false)
    expect(portlessMocks.removePortlessAliases).toHaveBeenCalledOnce()
    expect(portlessMocks.stopPortlessProxy).toHaveBeenCalledOnce()
  })
})

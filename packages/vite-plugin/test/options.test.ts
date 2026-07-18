import { afterEach, describe, expect, it, vi } from "vitest"

import {
  applyEthernaPluginHttpsFallback,
  defineEthernaPlugin,
  getDevServerPort,
} from "../src/options.ts"

import type { EthernaPluginOptions } from "../src/options.ts"
import type { ViteDevServer } from "vite"

describe("defineEthernaPlugin", () => {
  it("returns the same options object (identity helper)", () => {
    const options: EthernaPluginOptions = { gateway: true, https: true }
    expect(defineEthernaPlugin(options)).toBe(options)
  })
})

describe("getDevServerPort", () => {
  it("returns the port from the http server address", () => {
    const server = {
      httpServer: { address: () => ({ port: 4321 }) },
    } as unknown as ViteDevServer
    expect(getDevServerPort(server, 5173)).toBe(4321)
  })

  it("falls back when the address is a unix socket string", () => {
    const server = {
      httpServer: { address: () => "/tmp/vite.sock" },
    } as unknown as ViteDevServer
    expect(getDevServerPort(server, 5173)).toBe(5173)
  })

  it("falls back when there is no http server", () => {
    const server = { httpServer: null } as unknown as ViteDevServer
    expect(getDevServerPort(server, 8080)).toBe(8080)
  })
})

describe("applyEthernaPluginHttpsFallback", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("disables https and logs a warning", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const options: EthernaPluginOptions = { https: true }
    applyEthernaPluginHttpsFallback(options)
    expect(options.https).toBe(false)
    expect(log).toHaveBeenCalledOnce()
  })

  it("does nothing when https is not requested", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const options: EthernaPluginOptions = {}
    applyEthernaPluginHttpsFallback(options)
    expect(options.https).toBeUndefined()
    expect(log).not.toHaveBeenCalled()
  })
})

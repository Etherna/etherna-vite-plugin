import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Plugin } from "vite"

const { startMock, shutdownMock, generateSslCertificateMock } = vi.hoisted(() => {
  const shutdownMock = vi.fn(() => Promise.resolve())
  const startMock = vi.fn(() => Promise.resolve({ shutdown: shutdownMock }))
  const generateSslCertificateMock = vi.fn(() =>
    Promise.resolve({ cert: "CERT", key: "KEY", pfx: "PFX" }),
  )
  return { startMock, shutdownMock, generateSslCertificateMock }
})

vi.mock("@etherna/docker", () => ({ start: startMock }))
vi.mock("../src/ssl.ts", () => ({ generateSslCertificate: generateSslCertificateMock }))

class FakeHttpServer extends EventEmitter {
  address() {
    return { port: 5173 }
  }
}

function getConfigureServer(plugin: Plugin) {
  const hook = plugin.configureServer
  return typeof hook === "function" ? hook : hook?.handler
}

function getConfigResolved(plugin: Plugin) {
  const hook = plugin.configResolved
  return typeof hook === "function" ? hook : hook?.handler
}

async function runConfigureServer(plugin: Plugin, httpServer: FakeHttpServer) {
  const configureServer = getConfigureServer(plugin)
  await configureServer?.call({} as never, { httpServer } as never)
}

describe("etherna plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startMock.mockResolvedValue({ shutdown: shutdownMock })
  })

  it("does not call start when enabled is false", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const { etherna } = await import("../src/index.ts")
    const plugin = etherna({ enabled: false, bee: true })
    const httpServer = new FakeHttpServer()

    await runConfigureServer(plugin, httpServer)
    httpServer.emit("listening")
    await new Promise((r) => setTimeout(r, 0))

    expect(startMock).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledOnce()
    log.mockRestore()
  })

  it("calls start on listening with the resolved dev-server port and service options", async () => {
    const { etherna } = await import("../src/index.ts")
    const plugin = etherna({ bee: true, gateway: false })
    const httpServer = new FakeHttpServer()

    await runConfigureServer(plugin, httpServer)
    httpServer.emit("listening")

    await vi.waitFor(() => {
      expect(startMock).toHaveBeenCalledWith({
        bee: true,
        gateway: false,
        appPort: 5173,
        mode: "http",
        installSignalHandlers: true,
      })
    })
  })

  it("passes https mode and strips vite-only options from start", async () => {
    const { etherna } = await import("../src/index.ts")
    const plugin = etherna({ bee: true, https: true, enabled: true })
    const httpServer = new FakeHttpServer()

    await runConfigureServer(plugin, httpServer)
    httpServer.emit("listening")

    await vi.waitFor(() => {
      expect(startMock).toHaveBeenCalledOnce()
    })
    const firstCall = startMock.mock.calls[0] as unknown as unknown[]
    const startArgs = (firstCall?.[0] ?? {}) as Record<string, unknown>
    expect(startArgs.mode).toBe("https")
    expect(startArgs).not.toHaveProperty("https")
    expect(startArgs).not.toHaveProperty("enabled")
  })

  it("calls shutdown when the dev server closes", async () => {
    const { etherna } = await import("../src/index.ts")
    const plugin = etherna({ bee: true })
    const httpServer = new FakeHttpServer()

    await runConfigureServer(plugin, httpServer)
    httpServer.emit("listening")
    await vi.waitFor(() => {
      expect(startMock).toHaveBeenCalledOnce()
    })

    httpServer.emit("close")
    await vi.waitFor(() => {
      expect(shutdownMock).toHaveBeenCalledOnce()
    })
  })

  it("injects the SSL certificate into server/preview config when https is requested", async () => {
    const { etherna } = await import("../src/index.ts")
    const plugin = etherna({ https: true })
    const config = { server: {}, preview: {} } as {
      server: { https?: unknown; port?: number }
      preview: { https?: unknown }
    }

    const configResolved = getConfigResolved(plugin)
    await configResolved?.call({} as never, config as never)

    expect(generateSslCertificateMock).toHaveBeenCalledOnce()
    expect(config.server.https).toEqual({ cert: "CERT", key: "KEY" })
    expect(config.preview.https).toEqual({ cert: "CERT", key: "KEY" })
    expect(config.server.port).toBe(5371)
  })

  it("sets the default http app port and skips SSL when https is not requested", async () => {
    const { etherna } = await import("../src/index.ts")
    const plugin = etherna({})
    const config = { server: {}, preview: {} } as {
      server: { https?: unknown; port?: number }
      preview: { https?: unknown }
    }

    const configResolved = getConfigResolved(plugin)
    await configResolved?.call({} as never, config as never)

    expect(generateSslCertificateMock).not.toHaveBeenCalled()
    expect(config.server.https).toBeUndefined()
    expect(config.server.port).toBe(5173)
  })
})

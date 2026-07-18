import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/manager.ts", () => ({
  start: vi.fn(() => Promise.resolve({ shutdown: vi.fn(() => Promise.resolve()) })),
  stop: vi.fn(() => Promise.resolve()),
}))

import { getCliHelp, parseCliArgs, resolveCliServiceSelection, runCli } from "../src/cli.ts"
import { start, stop } from "../src/manager.ts"

describe("parseCliArgs", () => {
  it("parses start services and portless options", () => {
    expect(parseCliArgs(["start", "sso", "gateway", "--portless", "--app-port", "3000"])).toEqual({
      command: "start",
      services: ["sso", "gateway"],
      options: {
        appPort: 3000,
        portless: true,
      },
    })
  })

  it("defaults to help when no command is given", () => {
    expect(parseCliArgs([])).toEqual({ command: "help", services: [], options: {} })
  })

  it("parses stop command", () => {
    expect(parseCliArgs(["stop", "mongo", "sso"])).toEqual({
      command: "stop",
      services: ["mongo", "sso"],
      options: {},
    })
  })

  it("rejects stop without services", () => {
    expect(() => parseCliArgs(["stop"])).toThrow(/service/i)
  })

  it("rejects an unknown command", () => {
    expect(() => parseCliArgs(["bogus"])).toThrow(/unknown command/i)
  })

  it("rejects an unknown service name", () => {
    expect(() => parseCliArgs(["start", "not-a-service"])).toThrow(/unknown service/i)
  })

  it("parses --attached and --no-portless", () => {
    expect(parseCliArgs(["start", "mongo", "--attached", "--no-portless"])).toEqual({
      command: "start",
      services: ["mongo"],
      options: { detached: false, portless: false },
    })
  })
})

describe("resolveCliServiceSelection", () => {
  it("includes transitive dependencies for gateway startup using the canonical Vite graph", () => {
    // Vite gateway deps are mongo + sso only — unlike the legacy CLI graph, which also pulled in
    // beehive/bee.
    expect(resolveCliServiceSelection(["gateway"])).toEqual({
      blockchain: false,
      elastic: false,
      mongo: true,
      bee: false,
      sso: true,
      index: false,
      gateway: true,
      credit: false,
      beehive: false,
      shkeeper: false,
    })
  })

  it("enables shkeeper as a credit dependency (canonical Vite graph, unlike the legacy CLI graph)", () => {
    expect(resolveCliServiceSelection(["credit"])).toEqual({
      blockchain: false,
      elastic: false,
      mongo: true,
      bee: false,
      sso: true,
      index: false,
      gateway: false,
      credit: true,
      beehive: false,
      shkeeper: true,
    })
  })

  it("treats all as every default service except shkeeper", () => {
    expect(resolveCliServiceSelection(["all"])).toEqual({
      blockchain: true,
      elastic: true,
      mongo: true,
      bee: true,
      sso: true,
      index: true,
      gateway: true,
      credit: true,
      beehive: true,
      shkeeper: false,
    })
  })

  it("defaults an empty selection to all except shkeeper", () => {
    expect(resolveCliServiceSelection([])).toEqual(resolveCliServiceSelection(["all"]))
  })

  it("enables shkeeper when explicitly requested with all", () => {
    expect(resolveCliServiceSelection(["all", "shkeeper"]).shkeeper).toBe(true)
  })
})

describe("getCliHelp", () => {
  it("documents both start and stop commands", () => {
    const help = getCliHelp()
    expect(help).toMatch(/etherna start/)
    expect(help).toMatch(/etherna stop/)
  })
})

describe("runCli", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it("prints help and does not touch start/stop", async () => {
    await runCli([])
    expect(console.log).toHaveBeenCalledWith(getCliHelp())
    expect(start).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it("start defaults detached to true, enables default services, and exits after start", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await runCli(["start"])

    expect(start).toHaveBeenCalledWith({
      detached: true,
      portless: undefined,
      appPort: undefined,
      installSignalHandlers: true,
      elastic: true,
      mongo: true,
      bee: true,
      sso: true,
      index: true,
      gateway: true,
      credit: true,
      beehive: true,
    })
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it("start with --attached stays running (no process.exit) and maps only the requested services", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await runCli(["start", "gateway", "--attached"])

    expect(start).toHaveBeenCalledWith({
      detached: false,
      portless: undefined,
      appPort: undefined,
      installSignalHandlers: true,
      elastic: false,
      mongo: true,
      bee: false,
      sso: true,
      index: false,
      gateway: true,
      credit: false,
      beehive: false,
    })
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("stop calls stop() with the parsed services", async () => {
    await runCli(["stop", "mongo", "sso"])
    expect(stop).toHaveBeenCalledWith(["mongo", "sso"])
    expect(start).not.toHaveBeenCalled()
  })

  it("stop all expands to every service", async () => {
    await runCli(["stop", "all"])
    expect(stop).toHaveBeenCalledWith([
      "blockchain",
      "bee",
      "beehive",
      "credit",
      "elastic",
      "gateway",
      "index",
      "mongo",
      "shkeeper",
      "sso",
    ])
  })

  it("prints an error and sets exitCode 1 for invalid input, without calling start/stop", async () => {
    await runCli(["bogus"])
    expect(console.error).toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(start).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })
})

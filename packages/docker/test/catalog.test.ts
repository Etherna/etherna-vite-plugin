import { describe, expect, it } from "vitest"

import { ALL_SERVICE_NAMES, DEFAULT_START_SERVICE_NAMES, resolveEnabledFromServices, SERVICE_CATALOG } from "../src/catalog.ts"
import { containerNamesFor } from "../src/runtime/names.ts"

describe("containerNamesFor", () => {
  it("returns the full bee group", () => {
    expect(containerNamesFor("bee")).toEqual([
      "etherna-blockchain",
      "etherna-bee",
      "etherna-bee_worker_1",
    ])
  })

  it("returns blockchain only", () => {
    expect(containerNamesFor("blockchain")).toEqual(["etherna-blockchain"])
  })

  it("returns the full shkeeper stack", () => {
    expect(containerNamesFor("shkeeper")).toEqual([
      "ethereum-shkeeper-mariadb",
      "ethereum-shkeeper-redis",
      "ethereum-shkeeper",
      "ethereum-tasks",
      "shkeeper",
    ])
  })

  it("returns a single-container group for a simple service", () => {
    expect(containerNamesFor("mongo")).toEqual(["etherna-mongodb"])
  })
})

describe("SERVICE_CATALOG", () => {
  it("defines default start services without opt-in shkeeper", () => {
    expect(DEFAULT_START_SERVICE_NAMES).toEqual(ALL_SERVICE_NAMES.filter((name) => name !== "shkeeper"))
  })

  it("matches the canonical Vite-plugin dependency graph (not the legacy CLI graph)", () => {
    expect(SERVICE_CATALOG["bee-blockchain"].dependencies).toEqual([])
    expect(SERVICE_CATALOG["bee-nodes"].dependencies).toEqual(["bee-blockchain"])
    expect(SERVICE_CATALOG.shkeeper.dependencies).toEqual([])
    expect(SERVICE_CATALOG.mongo.dependencies).toEqual([])
    expect(SERVICE_CATALOG.sso.dependencies).toEqual(["mongo"])
    expect(SERVICE_CATALOG.index.dependencies).toEqual(["mongo"])
    expect(SERVICE_CATALOG.beehive.dependencies).toEqual(["mongo"])
    expect(SERVICE_CATALOG.gateway.dependencies).toEqual(["mongo", "sso"])
    // beehive is NOT a gateway dependency in the Vite tree, unlike the legacy CLI graph
    expect(SERVICE_CATALOG.gateway.dependencies).not.toContain("beehive")
    expect(SERVICE_CATALOG.credit.dependencies).toEqual(["mongo", "sso", "shkeeper"])
    expect(SERVICE_CATALOG.elastic.dependencies).toEqual([])

    for (const code of Object.keys(SERVICE_CATALOG) as (keyof typeof SERVICE_CATALOG)[]) {
      expect(SERVICE_CATALOG[code].onFailure).toBe("stop")
    }
  })
})

describe("resolveEnabledFromServices", () => {
  it("includes transitive deps for gateway using the Vite canonical graph", () => {
    expect(resolveEnabledFromServices(["gateway"])).toMatchObject({
      mongo: true,
      sso: true,
      gateway: true,
      // beehive is NOT required by Vite gateway deps — do not invent CLI-only deps
      beehive: false,
      bee: false,
    })
  })

  it("includes transitive deps for credit (mongo, sso, shkeeper)", () => {
    expect(resolveEnabledFromServices(["credit"])).toMatchObject({
      mongo: true,
      sso: true,
      shkeeper: true,
      credit: true,
      gateway: false,
      beehive: false,
      bee: false,
      elastic: false,
    })
  })

  it("expands blockchain to bee-blockchain only, not bee-nodes", () => {
    const enabled = resolveEnabledFromServices(["blockchain"])
    expect(enabled.blockchain).toBe(true)
    expect(enabled.bee).toBe(false)
  })

  it("expands bee to both bee-blockchain and bee-nodes, enabling blockchain too", () => {
    const enabled = resolveEnabledFromServices(["bee"])
    expect(enabled.bee).toBe(true)
    expect(enabled.blockchain).toBe(true)
  })

  it("returns all-false when given no services", () => {
    const enabled = resolveEnabledFromServices([])
    expect(Object.values(enabled).every((v) => !v)).toBe(true)
  })
})

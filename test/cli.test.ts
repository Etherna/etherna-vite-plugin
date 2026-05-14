import { describe, expect, it } from "vitest"

import { parseCliArgs, resolveCliServiceSelection } from "../src/cli.ts"

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
})

describe("resolveCliServiceSelection", () => {
  it("includes transitive dependencies for gateway startup", () => {
    expect(resolveCliServiceSelection(["gateway"])).toEqual({
      elastic: false,
      mongo: true,
      bee: true,
      sso: true,
      index: false,
      gateway: true,
      credit: false,
      beehive: true,
      shkeeper: false,
    })
  })

  it("treats all as every top-level service", () => {
    expect(resolveCliServiceSelection(["all"])).toEqual({
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

  it("does not start shkeeper as a credit dependency", () => {
    expect(resolveCliServiceSelection(["credit"])).toEqual({
      elastic: false,
      mongo: true,
      bee: false,
      sso: true,
      index: false,
      gateway: false,
      credit: true,
      beehive: false,
      shkeeper: false,
    })
  })
})

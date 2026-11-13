import { expect, it } from "vitest"

import {
  getPortlessPublicUrl,
  normalizePortlessAppPublicUrl,
  parsePortlessPort,
  portlessAliasAddArgs,
  portlessCliEnv,
  portlessProxyStartArgs,
} from "../src/portless.ts"

it("getPortlessPublicUrl uses http://alias.localhost with no port", () => {
  expect(getPortlessPublicUrl("sso")).toBe("http://sso.localhost")
  expect(getPortlessPublicUrl("bee")).toBe("http://bee.localhost")
})

it("portlessProxyStartArgs starts an unprivileged HTTP proxy on the default port", () => {
  expect(portlessProxyStartArgs()).toEqual(["proxy", "start", "--no-tls", "--unprivileged"])
})

it("portlessCliEnv sets PORTLESS_UNPRIVILEGED so the proxy can bind port 80", () => {
  expect(portlessCliEnv({ PATH: "/usr/bin" })).toEqual({
    PATH: "/usr/bin",
    PORTLESS_UNPRIVILEGED: "1",
  })
})

it("portlessAliasAddArgs includes force when requested", () => {
  expect(portlessAliasAddArgs("sso", 32610, true)).toEqual(["alias", "sso", "32610", "--force"])
})

it("normalizePortlessAppPublicUrl trims and strips trailing slashes", () => {
  expect(normalizePortlessAppPublicUrl("  http://dapp.localhost/  ")).toBe("http://dapp.localhost")
})

it("parsePortlessPort accepts numbers and numeric strings", () => {
  expect(parsePortlessPort(32610)).toBe(32610)
  expect(parsePortlessPort("32610")).toBe(32610)
  expect(parsePortlessPort("  80 ")).toBe(80)
})

it("parsePortlessPort rejects empty and invalid values", () => {
  expect(() => parsePortlessPort("")).toThrow(/empty/)
  expect(() => parsePortlessPort("not-a-port")).toThrow(/Invalid port/)
})

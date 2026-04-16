import { expect, it } from "vitest"

import {
  PORTLESS_PROXY_PORT,
  getPortlessPublicUrl,
  normalizePortlessAppPublicUrl,
  portlessAliasAddArgs,
  portlessProxyStartArgs,
} from "../src/portless.ts"

it("PORTLESS_PROXY_PORT is 1355", () => {
  expect(PORTLESS_PROXY_PORT).toBe(1355)
})

it("getPortlessPublicUrl builds http://alias.localhost:1355", () => {
  expect(getPortlessPublicUrl("sso")).toBe("http://sso.localhost:1355")
  expect(getPortlessPublicUrl("bee")).toBe("http://bee.localhost:1355")
})

it("portlessProxyStartArgs pins HTTP proxy to port 1355 without TLS", () => {
  expect(portlessProxyStartArgs()).toEqual(["proxy", "start", "-p", "1355", "--no-tls"])
})

it("portlessAliasAddArgs includes force when requested", () => {
  expect(portlessAliasAddArgs("sso", 32610, true)).toEqual(["alias", "sso", "32610", "--force"])
})

it("normalizePortlessAppPublicUrl trims and strips trailing slashes", () => {
  expect(normalizePortlessAppPublicUrl("  http://dapp.localhost:1355/  ")).toBe(
    "http://dapp.localhost:1355",
  )
})

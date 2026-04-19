import { afterEach, describe, expect, it } from "vitest"

import { ETHERNA_DETACHED_ENV, resolveDetachedMode } from "../src/plugin-define.ts"

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

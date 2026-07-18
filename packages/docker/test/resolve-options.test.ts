import { afterEach, describe, expect, it } from "vitest"

import { ETHERNA_DETACHED_ENV, resolveDetachedMode, resolveStartPlan } from "../src/resolve-options.ts"

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

  it("defaults to false when env is unset", () => {
    expect(resolveDetachedMode({})).toBe(false)
  })

  it("explicit detached overrides env", () => {
    process.env[ETHERNA_DETACHED_ENV] = "1"
    expect(resolveDetachedMode({ detached: false })).toBe(false)
  })
})

describe("resolveStartPlan", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, ETHERNA_DETACHED_ENV)
  })

  it("enables every service by default except shkeeper (opt-in)", () => {
    const plan = resolveStartPlan({})
    expect(plan.enabled).toEqual({
      blockchain: true,
      bee: true,
      beehive: true,
      credit: true,
      elastic: true,
      gateway: true,
      index: true,
      mongo: true,
      shkeeper: false,
      sso: true,
    })
  })

  it("disables a service when explicitly set to false", () => {
    const plan = resolveStartPlan({ mongo: false, shkeeper: false })
    expect(plan.enabled.mongo).toBe(false)
    expect(plan.enabled.shkeeper).toBe(false)
    expect(plan.enabled.sso).toBe(true)
  })

  it("treats a ServiceConfig object without `enabled: false` as enabled", () => {
    const plan = resolveStartPlan({ mongo: {}, sso: { env: {} } })
    expect(plan.enabled.mongo).toBe(true)
    expect(plan.enabled.sso).toBe(true)
  })

  it("disables a service via ServiceConfig `enabled: false`", () => {
    const plan = resolveStartPlan({ mongo: { enabled: false } })
    expect(plan.enabled.mongo).toBe(false)
  })

  it("enables shkeeper only when explicitly opted in via true or a config object", () => {
    expect(resolveStartPlan({}).enabled.shkeeper).toBe(false)
    expect(resolveStartPlan({ shkeeper: false }).enabled.shkeeper).toBe(false)
    expect(resolveStartPlan({ shkeeper: true }).enabled.shkeeper).toBe(true)
    expect(resolveStartPlan({ shkeeper: { build: { githubRepo: "etherna/shkeeper" } } }).enabled.shkeeper).toBe(
      true,
    )
    expect(resolveStartPlan({ shkeeper: { enabled: false } }).enabled.shkeeper).toBe(false)
  })

  it("mirrors the bee flag onto blockchain (no independent StartOptions toggle)", () => {
    expect(resolveStartPlan({ bee: false }).enabled.blockchain).toBe(false)
    expect(resolveStartPlan({ bee: true }).enabled.blockchain).toBe(true)
    expect(resolveStartPlan({}).enabled.blockchain).toBe(true)
  })

  it("defaults detached/portless/mode/installSignalHandlers and passes through appPort", () => {
    const plan = resolveStartPlan({})
    expect(plan.detached).toBe(false)
    expect(plan.portless).toBe(false)
    expect(plan.mode).toBe("http")
    expect(plan.installSignalHandlers).toBe(true)
    expect(plan.appPort).toBeUndefined()
  })

  it("honors explicit detached/portless/mode/installSignalHandlers/appPort", () => {
    const plan = resolveStartPlan({
      detached: true,
      portless: true,
      mode: "https",
      installSignalHandlers: false,
      appPort: 5555,
    })
    expect(plan.detached).toBe(true)
    expect(plan.portless).toBe(true)
    expect(plan.mode).toBe("https")
    expect(plan.installSignalHandlers).toBe(false)
    expect(plan.appPort).toBe(5555)
  })

  it("falls back to ETHERNA_DETACHED env for detached when omitted", () => {
    process.env[ETHERNA_DETACHED_ENV] = "true"
    expect(resolveStartPlan({}).detached).toBe(true)
  })
})

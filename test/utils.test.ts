import { afterEach, describe, expect, it, vi } from "vitest"

import { getEnvVar } from "../src/utils.ts"

const TEST_KEY = "ETHERNA_TEST_GET_ENV_VAR"

describe("getEnvVar", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, TEST_KEY)
    vi.unstubAllEnvs()
  })

  it("returns undefined when neither source has the key", () => {
    expect(getEnvVar(TEST_KEY)).toBeUndefined()
  })

  it("reads from process.env", () => {
    process.env[TEST_KEY] = "from-process"
    expect(getEnvVar(TEST_KEY)).toBe("from-process")
  })

  it("returns the value when stubbed via vi.stubEnv (process.env + import.meta.env)", () => {
    vi.stubEnv(TEST_KEY, "stubbed")
    expect(getEnvVar(TEST_KEY)).toBe("stubbed")
  })

  it("preserves empty strings set in process.env", () => {
    process.env[TEST_KEY] = ""
    expect(getEnvVar(TEST_KEY)).toBe("")
  })
})

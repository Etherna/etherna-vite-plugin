import { describe, expect, it } from "vitest"

import { buildServiceEnvs, parsePortFromAspNetCoreUrls } from "../src/envs.ts"

describe("buildServiceEnvs", () => {
  it("builds a docker-only ETH profile for shkeeper with localhost service discovery", () => {
    const envs = buildServiceEnvs({ mode: "http", portless: false, appPort: 5174 })

    expect(envs.shkeeper.port).toBe(32650)
    expect(envs["shkeeper-core"].ETH_WALLET).toBe("enabled")
    expect(envs["shkeeper-core"].BTC_WALLET).toBe("disabled")
    expect(envs["shkeeper-core"].ETHEREUM_API_SERVER_HOST).toBe("localhost")
    expect(envs["shkeeper-core"].ETHEREUM_SERVER_PORT).toBe("6000")
    expect(envs["ethereum-shkeeper"].FULLNODE_URL).toBe("http://localhost:9545")
    expect(envs["ethereum-shkeeper"].SHKEEPER_HOST).toBe("localhost:32650")
    expect(envs["ethereum-shkeeper"].REDIS_HOST).toBe("localhost")
    expect(envs["ethereum-shkeeper"].SQLALCHEMY_DATABASE_URI).toBe(
      "mariadb+pymysql://root:shkeeper@localhost:3306/ethereum-shkeeper?charset=utf8mb4",
    )
  })

  it("uses localhost for bind and public URLs when portless is off", () => {
    const envs = buildServiceEnvs({ mode: "http", portless: false, appPort: 5174 })
    expect(envs["etherna-sso"].ASPNETCORE_URLS).toBe("http://localhost:32610")
    expect(envs["etherna-sso"]["IdServer:SsoServer:BaseUrl"]).toBe("http://localhost:32610")
    expect(envs.app.port).toBe(5174)
    expect(envs["etherna-beehive"]["SeedDb:BeeNodes:0:ConnectionString"]).toBe(
      "http://localhost:1633",
    )
  })

  it("keeps ASPNETCORE bind URLs on localhost ports when portless is on", () => {
    const envs = buildServiceEnvs({ mode: "http", portless: true, appPort: 9999 })
    expect(envs["etherna-sso"].ASPNETCORE_URLS).toBe("http://localhost:32610")
    expect(envs["etherna-gateway"].ASPNETCORE_URLS).toBe("http://localhost:32640")
  })

  it("uses PORTLESS_URL override for dapp client base URL when portlessAppPublicUrl is set", () => {
    const envs = buildServiceEnvs({
      mode: "http",
      portless: true,
      appPort: 9999,
      portlessAppPublicUrl: "http://dapp.etherna.localhost:1355/",
    })
    expect(envs["etherna-sso"]["IdServer:Clients:EthernaDapp:BaseUrl"]).toBe(
      "http://dapp.etherna.localhost:1355",
    )
  })

  it("uses portless only for browser-facing client base URLs when portless is on", () => {
    const envs = buildServiceEnvs({ mode: "http", portless: true, appPort: 9999 })
    expect(envs["etherna-sso"]["IdServer:Clients:EthernaDapp:BaseUrl"]).toBe(
      "http://app.localhost:1355",
    )
    expect(envs["etherna-sso"]["IdServer:Clients:EthernaIndex:BaseUrl"]).toBe(
      "http://index.localhost:1355",
    )
    expect(envs["etherna-sso"]["IdServer:SsoServer:BaseUrl"]).toBe("http://localhost:32610")
    expect(envs["etherna-index"]["SsoServer:BaseUrl"]).toBe("http://localhost:32610")
    expect(envs["etherna-index"]["Swarm:GatewayUrl"]).toBe("http://localhost:32640")
    expect(envs["etherna-gateway"]["Bee:DirectUrl"]).toBe("http://localhost:12610")
    expect(envs["etherna-beehive"]["SeedDb:BeeNodes:0:ConnectionString"]).toBe(
      "http://localhost:1633",
    )
  })

  it("keeps authority URLs on localhost bind when mode is https (even with portless flag)", () => {
    const envs = buildServiceEnvs({ mode: "https", portless: true, appPort: 5371 })
    expect(envs["etherna-sso"]["IdServer:SsoServer:BaseUrl"]).toMatch(/^https:\/\/localhost:/)
  })
})

describe("parsePortFromAspNetCoreUrls", () => {
  it("parses port from the first binding URL", () => {
    expect(parsePortFromAspNetCoreUrls("http://localhost:32610")).toBe("32610")
    expect(parsePortFromAspNetCoreUrls("http://localhost:32610;http://127.0.0.1:32610")).toBe(
      "32610",
    )
  })
})

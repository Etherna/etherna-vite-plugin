import { CERTIFICATE_PASSWORD, CERTIFICATE_PFX_NAME, CONTAINER_CERTS_DIR } from "./consts"
import {
  getPortlessPublicUrl,
  normalizePortlessAppPublicUrl,
  type PortlessServiceAlias,
} from "./portless"

export const APP_PORT = 5173
const APP_HTTPS_PORT = 5371

const MONGODB_PORT = 27017
const BEE_PORT = 1633
const BEE_P2P_PORT = 1634
const BLOCKCHAIN_PORT = 9545
const NETWORK_ID = 4020

const SSO_HTTP_PORT = 32610
const SSO_HTTPS_PORT = 42610

const INDEX_HTTP_PORT = 32620
const INDEX_HTTPS_PORT = 42620

const CREDIT_HTTP_PORT = 32630
const CREDIT_HTTPS_PORT = 42630

const GATEWAY_HTTP_PORT = 32640
const GATEWAY_HTTPS_PORT = 42640

const BEEHIVE_HTTP_PORT = 12610

type UnionToIntersection<Union> = (
  Union extends unknown ? (distributedUnion: Union) => void : never
) extends (mergedIntersection: infer Intersection) => void
  ? Intersection & Union
  : never

type StringEnvOverride<T extends Record<string, string | number>> = Partial<Record<keyof T, string>>

/** Runtime context for building service envs (bind URLs vs public Portless URLs). */
export interface ServiceEnvBuildContext {
  mode: "http" | "https"
  portless: boolean
  /** Actual Vite dev server port (may differ from {@link APP_PORT}). */
  appPort: number
  /**
   * When set (e.g. `PORTLESS_URL` from the Portless CLI), used as the browser-facing dapp base URL
   * instead of `http://app.localhost:1355`. The plugin skips registering the `app` Portless alias.
   */
  portlessAppPublicUrl?: string
}

export function defaultServiceEnvBuildContext(mode: "http" | "https"): ServiceEnvBuildContext {
  return {
    mode,
    portless: false,
    appPort: mode === "http" ? APP_PORT : APP_HTTPS_PORT,
  }
}

/** Parses the listen port from `ASPNETCORE_URLS` (first URL if semicolon-separated). */
export function parsePortFromAspNetCoreUrls(bindUrls: string): string {
  const first = bindUrls.split(";")[0]?.trim() ?? ""
  try {
    const u = new URL(first)
    if (u.port) {
      return u.port
    }
    return u.protocol === "https:" ? "443" : "80"
  } catch {
    return first.split(":")[2] ?? "80"
  }
}

function bindUrl(mode: "http" | "https", port: number): string {
  return `${mode}://localhost:${port}`
}

function publicHttpUrl(
  mode: "http" | "https",
  port: number,
  portless: boolean,
  alias: PortlessServiceAlias,
): string {
  if (portless) {
    return getPortlessPublicUrl(alias)
  }
  return bindUrl(mode, port)
}

export function buildServiceEnvs(context: ServiceEnvBuildContext) {
  const { mode, portless, appPort, portlessAppPublicUrl } = context

  const ssoPort = mode === "http" ? SSO_HTTP_PORT : SSO_HTTPS_PORT
  const indexPort = mode === "http" ? INDEX_HTTP_PORT : INDEX_HTTPS_PORT
  const creditPort = mode === "http" ? CREDIT_HTTP_PORT : CREDIT_HTTPS_PORT
  const gatewayPort = mode === "http" ? GATEWAY_HTTP_PORT : GATEWAY_HTTPS_PORT
  const beehivePort = BEEHIVE_HTTP_PORT

  const mongodbUrl = `mongodb://localhost:${MONGODB_PORT}`
  const ssoBindUrl = bindUrl(mode, ssoPort)
  const indexBindUrl = bindUrl(mode, indexPort)
  const creditBindUrl = bindUrl(mode, creditPort)
  const gatewayBindUrl = bindUrl(mode, gatewayPort)
  const beehiveBindUrl = bindUrl(mode, beehivePort)
  /** Direct Bee API URL for container-to-container calls (always `localhost`; `*.localhost` Portless hosts often do not resolve inside Docker). */
  const beeApiBindUrl = `http://localhost:${BEE_PORT}`

  const appPublicUrl =
    portless && portlessAppPublicUrl
      ? normalizePortlessAppPublicUrl(portlessAppPublicUrl)
      : publicHttpUrl(mode, appPort, portless, "app")
  const indexPublicUrl = publicHttpUrl(mode, indexPort, portless, "index")
  const creditPublicUrl = publicHttpUrl(mode, creditPort, portless, "credit")
  const gatewayPublicUrl = publicHttpUrl(mode, gatewayPort, portless, "gateway")

  const baseAspEnv = {
    ASPNETCORE_ENVIRONMENT: "Development",
    "Elastic:Urls:0": "http://localhost:9200",
    ...(mode === "https"
      ? {
          ASPNETCORE_Kestrel__Certificates__Default__Path: `${CONTAINER_CERTS_DIR}/${CERTIFICATE_PFX_NAME}`,
          ASPNETCORE_Kestrel__Certificates__Default__Password: CERTIFICATE_PASSWORD,
        }
      : {}),
  }

  const envs = {
    app: {
      port: appPort,
    },
    elastic: {
      "discovery.type": "single-node",
      "xpack.security.enabled": "false",
      ES_JAVA_OPTS: "-Xms512m -Xmx512m",
    },
    "etherna-mongodb": {},
    "etherna-sso": {
      ...baseAspEnv,
      ASPNETCORE_URLS: ssoBindUrl,
      /** Issuer/authority for discovery; keep bind URL so services and DNS inside containers resolve it. */
      "IdServer:SsoServer:BaseUrl": ssoBindUrl,
      "IdServer:SsoServer:AllowUnsafeConnection": "true",
      "IdServer:Clients:EthernaCredit:BaseUrl": creditPublicUrl,
      "IdServer:Clients:EthernaGateway:BaseUrls:0": gatewayPublicUrl,
      "IdServer:Clients:EthernaIndex:BaseUrl": indexPublicUrl,
      "IdServer:Clients:EthernaDapp:BaseUrl": appPublicUrl,
      "ConnectionStrings:DataProtectionDb": `${mongodbUrl}/ethernaSSODataProtectionDev`,
      "ConnectionStrings:HangfireDb": `${mongodbUrl}/ethernaSSOHangfireDev`,
      "ConnectionStrings:ServiceSharedDb": `${mongodbUrl}/ethernaServiceSharedDev`,
      "ConnectionStrings:SSOServerDb": `${mongodbUrl}/ethernaSSODev`,
    },
    "etherna-index": {
      ...baseAspEnv,
      ASPNETCORE_URLS: indexBindUrl,
      "Swarm:GatewayUrl": gatewayBindUrl,
      /** Server-side HTTP to SSO/Gateway must use bind URLs; `*.localhost` Portless names often fail in containers. */
      "SsoServer:BaseUrl": ssoBindUrl,
      "SsoServer:AllowUnsafeConnection": "true",
      "ConnectionStrings:DataProtectionDb": `${mongodbUrl}/ethernaSharedDataProtectionDev`,
      "ConnectionStrings:HangfireDb": `${mongodbUrl}/ethernaIndexHangfireDev`,
      "ConnectionStrings:IndexDb": `${mongodbUrl}/ethernaIndexDev`,
      "ConnectionStrings:ServiceSharedDb": `${mongodbUrl}/ethernaServiceSharedDev`,
    },
    "etherna-credit": {
      ...baseAspEnv,
      ASPNETCORE_URLS: creditBindUrl,
      "SsoServer:BaseUrl": ssoBindUrl,
      "SsoServer:AllowUnsafeConnection": "true",
      "ConnectionStrings:DataProtectionDb": `${mongodbUrl}/ethernaSharedDataProtectionDev`,
      "ConnectionStrings:HangfireDb": `${mongodbUrl}/ethernaCreditHangfireDev`,
      "ConnectionStrings:CreditDb": `${mongodbUrl}/ethernaCreditDev`,
      "ConnectionStrings:ServiceSharedDb": `${mongodbUrl}/ethernaServiceSharedDev`,
    },
    "etherna-gateway": {
      ...baseAspEnv,
      ASPNETCORE_URLS: gatewayBindUrl,
      "ForwardedHeaders:KnownNetworks:0": "0.0.0.0/0",
      "SsoServer:BaseUrl": ssoBindUrl,
      "SsoServer:Clients:Credit:BaseUrl": creditPublicUrl,
      "SsoServer:Clients:Credit:Secret": "ethernaGatewayCreditClientSecret",
      "SsoServer:Clients:Webapp:Secret": "ethernaGatewayWebappClientSecret",
      "SsoServer:AllowUnsafeConnection": "true",
      "Bee:CachedUrl": beehiveBindUrl,
      "Bee:DirectUrl": beehiveBindUrl,
      "Features:GarbageCollectPins": "false",
      ForwardedAllowedHosts: "*",
      "ConnectionStrings:DataProtectionDb": `${mongodbUrl}/ethernaSharedDataProtectionDev`,
      "ConnectionStrings:HangfireDb": `${mongodbUrl}/ethernaGatewayHangfireDev`,
      "ConnectionStrings:GatewayDb": `${mongodbUrl}/ethernaGatewayDev`,
      "ConnectionStrings:ServiceSharedDb": `${mongodbUrl}/ethernaServiceSharedDev`,
    },
    "etherna-beehive-manager": {
      ...baseAspEnv,
      ASPNETCORE_URLS: beehiveBindUrl,
      "SeedDb:BeeNodes:0:Hostname": "localhost",
      "ConnectionStrings:DataProtectionDb": `${mongodbUrl}/beehiveDataProtectionDev`,
      "ConnectionStrings:HangfireDb": `${mongodbUrl}/beehiveHangfireDev`,
      "ConnectionStrings:BeehiveDb": `${mongodbUrl}/beehiveDev`,
      "SeedDb:BeeNodes:0:ConnectionString": beeApiBindUrl,
      "SeedDb:BeeNodes:0:EnableBatchCreation": "true",
    },
    "etherna-blockchain": {
      BLOCKCHAIN_PORT,
      NETWORK_ID,
    },
    "etherna-bee": {
      BEE_WARMUP_TIME: "10s",
      BEE_DEBUG_API_ENABLE: "true",
      BEE_VERBOSITY: "4",
      BEE_SWAP_ENABLE: "true",
      BEE_MAINNET: "false",
      BEE_SWAP_ENDPOINT: `http://etherna-blockchain:${BLOCKCHAIN_PORT}`,
      BEE_BLOCKCHAIN_RPC_ENDPOINT: `http://etherna-blockchain:${BLOCKCHAIN_PORT}`,
      BEE_PASSWORD: "password",
      BEE_SWAP_FACTORY_ADDRESS: "0xCfEB869F69431e42cdB54A4F4f105C19C080A601",
      BEE_POSTAGE_STAMP_ADDRESS: "0x254dffcd3277C0b1660F6d42EFbB754edaBAbC2B",
      BEE_PRICE_ORACLE_ADDRESS: "0x5b1869D9A4C187F2EAa108f3062412ecf0526b24",
      BEE_REDISTRIBUTION_ADDRESS: "0x9561C133DD8580860B6b7E504bC5Aa500f0f06a7",
      BEE_STAKING_ADDRESS: "0xD833215cBcc3f914bD1C9ece3EE7BF8B14f841bb",
      BEE_POSTAGE_STAMP_START_BLOCK: "1",
      BEE_NETWORK_ID: NETWORK_ID,
      BEE_FULL_NODE: "true",
      BEE_PORT,
      BEE_P2P_PORT,
      BEE_API_ADDR: `0.0.0.0:${BEE_PORT}`,
      BEE_P2P_ADDR: `0.0.0.0:${BEE_P2P_PORT}`,
      BEE_CORS_ALLOWED_ORIGINS: "*",
      BEE_ALLOW_PRIVATE_CIDRS: "true",
      BEE_BOOTNODE_MODE: "",
      BEE_BOOTNODE: "",
    },
  } satisfies Record<string, Record<string, string | number>>

  return envs
}

export type BuiltServiceEnvs = ReturnType<typeof buildServiceEnvs>

export type ElasticEnv = StringEnvOverride<BuiltServiceEnvs["elastic"]>
export type MongoEnv = StringEnvOverride<BuiltServiceEnvs["etherna-mongodb"]>
export type BeeEnv = StringEnvOverride<
  BuiltServiceEnvs["etherna-blockchain"] & BuiltServiceEnvs["etherna-bee"]
>
export type SsoEnv = StringEnvOverride<BuiltServiceEnvs["etherna-sso"]>
export type IndexEnv = StringEnvOverride<BuiltServiceEnvs["etherna-index"]>
export type GatewayEnv = StringEnvOverride<BuiltServiceEnvs["etherna-gateway"]>
export type CreditEnv = StringEnvOverride<BuiltServiceEnvs["etherna-credit"]>
export type BeehiveEnv = StringEnvOverride<BuiltServiceEnvs["etherna-beehive-manager"]>

/** Union of env overrides accepted by ASP.NET Etherna containers (SSO, Index, Gateway, Credit, Beehive). */
export type AspServiceEnv = SsoEnv | IndexEnv | GatewayEnv | CreditEnv | BeehiveEnv

export const getEnv = <T extends string>(name: T, context: ServiceEnvBuildContext) => {
  const envs = buildServiceEnvs(context)
  type Env = typeof envs
  type AnyEnv = UnionToIntersection<Env[keyof Env]>
  type AnyEnvKey = keyof AnyEnv

  return ((envs as Record<string, unknown>)[name] ?? null) as T extends keyof Env
    ? Env[T]
    : Partial<Record<AnyEnvKey, string>> | null
}

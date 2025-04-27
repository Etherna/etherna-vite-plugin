import { CERTIFICATE_PASSWORD, CERTIFICATE_PFX_NAME, CONTAINER_CERTS_DIR } from "./consts"

const APP_PORT = 5173
const APP_HTTPS_PORT = 5371

const MONGODB_PORT = 27017
const BEE_PORT = 1633
export const BLOCKCHAIN_PORT = 9545

const SSO_HTTP_PORT = 32610
const SSO_HTTPS_PORT = 42610

const INDEX_HTTP_PORT = 32620
const INDEX_HTTPS_PORT = 42620

const CREDIT_HTTP_PORT = 32630
const CREDIT_HTTPS_PORT = 42630

const GATEWAY_HTTP_PORT = 32640
const GATEWAY_HTTPS_PORT = 42640

const BEEHIVE_HTTP_PORT = 12610

export const getEnv = <T extends string>(name: T, mode: "http" | "https") => {
  const appPort = mode === "http" ? APP_PORT : APP_HTTPS_PORT
  const ssoPort = mode === "http" ? SSO_HTTP_PORT : SSO_HTTPS_PORT
  const indexPort = mode === "http" ? INDEX_HTTP_PORT : INDEX_HTTPS_PORT
  const creditPort = mode === "http" ? CREDIT_HTTP_PORT : CREDIT_HTTPS_PORT
  const gatewayPort = mode === "http" ? GATEWAY_HTTP_PORT : GATEWAY_HTTPS_PORT
  const beehivePort = BEEHIVE_HTTP_PORT

  const appUrl = `${mode}://localhost:${appPort}`
  const mongodbUrl = `mongodb://localhost:${MONGODB_PORT}`
  const ssoUrl = `${mode}://localhost:${ssoPort}`
  const indexUrl = `${mode}://localhost:${indexPort}`
  const creditUrl = `${mode}://localhost:${creditPort}`
  const gatewayUrl = `${mode}://localhost:${gatewayPort}`
  const beehiveUrl = `${mode}://localhost:${beehivePort}`

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
    "etherna-sso": {
      ...baseAspEnv,
      ASPNETCORE_URLS: ssoUrl,
      "IdServer:SsoServer:BaseUrl": ssoUrl,
      "IdServer:SsoServer:AllowUnsafeConnection": "true",
      "IdServer:Clients:EthernaCredit:BaseUrl": creditUrl,
      "IdServer:Clients:EthernaGateway:BaseUrls:0": gatewayUrl,
      "IdServer:Clients:EthernaIndex:BaseUrl": indexUrl,
      "IdServer:Clients:EthernaDapp:BaseUrl": appUrl,
      "ConnectionStrings:DataProtectionDb": `${mongodbUrl}/ethernaSSODataProtectionDev`,
      "ConnectionStrings:HangfireDb": `${mongodbUrl}/ethernaSSOHangfireDev`,
      "ConnectionStrings:ServiceSharedDb": `${mongodbUrl}/ethernaServiceSharedDev`,
      "ConnectionStrings:SSOServerDb": `${mongodbUrl}/ethernaSSODev`,
    },
    "etherna-index": {
      ...baseAspEnv,
      ASPNETCORE_URLS: indexUrl,
      "SsoServer:BaseUrl": ssoUrl,
      "SsoServer:AllowUnsafeConnection": "true",
      "ConnectionStrings:DataProtectionDb": `${mongodbUrl}/ethernaSharedDataProtectionDev`,
      "ConnectionStrings:HangfireDb": `${mongodbUrl}/ethernaIndexHangfireDev`,
      "ConnectionStrings:IndexDb": `${mongodbUrl}/ethernaIndexDev`,
      "ConnectionStrings:ServiceSharedDb": `${mongodbUrl}/ethernaServiceSharedDev`,
    },
    "etherna-credit": {
      ...baseAspEnv,
      ASPNETCORE_URLS: creditUrl,
      "SsoServer:BaseUrl": ssoUrl,
      "SsoServer:AllowUnsafeConnection": "true",
      "ConnectionStrings:DataProtectionDb": `${mongodbUrl}/ethernaSharedDataProtectionDev`,
      "ConnectionStrings:HangfireDb": `${mongodbUrl}/ethernaCreditHangfireDev`,
      "ConnectionStrings:CreditDb": `${mongodbUrl}/ethernaCreditDev`,
      "ConnectionStrings:ServiceSharedDb": `${mongodbUrl}/ethernaServiceSharedDev`,
    },
    "etherna-gateway": {
      ...baseAspEnv,
      ASPNETCORE_URLS: gatewayUrl,
      "ForwardedHeaders:KnownNetworks:0": "0.0.0.0/0",
      "SsoServer:BaseUrl": ssoUrl,
      "SsoServer:Clients:Credit:BaseUrl": creditUrl,
      "SsoServer:AllowUnsafeConnection": "true",
      "BeehiveManager:Url": beehiveUrl,
      "ConnectionStrings:DataProtectionDb": `${mongodbUrl}/ethernaSharedDataProtectionDev`,
      "ConnectionStrings:HangfireDb": `${mongodbUrl}/ethernaGatewayHangfireDev`,
      "ConnectionStrings:GatewayDb": `${mongodbUrl}/ethernaGatewayDev`,
      "ConnectionStrings:ServiceSharedDb": `${mongodbUrl}/ethernaServiceSharedDev`,
    },
    "etherna-beehive-manager": {
      ...baseAspEnv,
      ASPNETCORE_URLS: beehiveUrl,
      "SeedDb:BeeNodes:0:Hostname": "localhost",
      "ConnectionStrings:DataProtectionDb": `${mongodbUrl}/beehiveManagerDataProtectionDev`,
      "ConnectionStrings:HangfireDb": `${mongodbUrl}/beehiveManagerHangfireDev`,
      "ConnectionStrings:BeehiveManagerDb": `${mongodbUrl}/beehiveManagerDev`,
    },
    "etherna-blockchain": {
      port: BLOCKCHAIN_PORT,
    },
    "etherna-bee": {
      BEE_WARMUP_TIME: "10s",
      BEE_DEBUG_API_ENABLE: "true",
      BEE_VERBOSITY: "4",
      BEE_SWAP_ENABLE: "true",
      BEE_MAINNET: "false",
      BEE_SWAP_ENDPOINT: `http://localhost:${BLOCKCHAIN_PORT}`,
      BEE_PASSWORD: "password",
      BEE_SWAP_FACTORY_ADDRESS: "0xCfEB869F69431e42cdB54A4F4f105C19C080A601",
      BEE_POSTAGE_STAMP_ADDRESS: "0x254dffcd3277C0b1660F6d42EFbB754edaBAbC2B",
      BEE_PRICE_ORACLE_ADDRESS: "0x5b1869D9A4C187F2EAa108f3062412ecf0526b24",
      BEE_REDISTRIBUTION_ADDRESS: "0x9561C133DD8580860B6b7E504bC5Aa500f0f06a7",
      BEE_STAKING_ADDRESS: "0xD833215cBcc3f914bD1C9ece3EE7BF8B14f841bb",
      BEE_POSTAGE_STAMP_START_BLOCK: "1",
      BEE_NETWORK_ID: "4020",
      BEE_FULL_NODE: "true",
      BEE_PORT,
      BEE_API_ADDR: `0.0.0.0:${BEE_PORT}`,
      BEE_CORS_ALLOWED_ORIGINS: "*",
      BEE_ALLOW_PRIVATE_CIDRS: "true",
    },
    "etherna-interceptor": {
      BASE_HOST: "localhost",
      BASE_HOST_PREFERRED_SCHEMA: mode,
      BEENODE_CACHED_HOST: `localhost:${BEE_PORT}`,
      BEENODE_CACHED_SCHEME: mode,
      BEENODE_DIRECT_HOST: `localhost:${BEE_PORT}`,
      BEENODE_DIRECT_SCHEME: mode,
      DASHBOARD_HOST: `localhost:${gatewayPort}`,
      RESOLVER: "127.0.0.1",
      VALIDATOR_HOST: `localhost:${gatewayPort}`,
      VALIDATOR_SCHEME: mode,
    },
  } satisfies Record<string, Record<string, string | number>>

  type UnionToIntersection<Union> = (
    Union extends unknown ? (distributedUnion: Union) => void : never
  ) extends (mergedIntersection: infer Intersection) => void
    ? Intersection & Union
    : never
  type Env = typeof envs
  type AnyEnv = UnionToIntersection<Env[keyof Env]>

  type AnyEnvKey = keyof AnyEnv

  return ((envs as Record<string, unknown>)[name] ?? null) as T extends keyof Env
    ? Env[T]
    : Partial<Record<AnyEnvKey, string>> | null
}

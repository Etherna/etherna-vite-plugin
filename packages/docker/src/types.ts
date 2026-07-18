/**
 * Logical Etherna service names. Matches today's CLI vocabulary (excluding `all`).
 * `blockchain` has no independent `StartOptions` toggle — it always mirrors `bee` — but is kept
 * as its own name because `stop("blockchain")` stops only the blockchain container while
 * `stop("bee")` stops the whole bee node group (see `containerNamesFor`).
 */
export type EthernaServiceName =
  | "blockchain"
  | "bee"
  | "beehive"
  | "credit"
  | "elastic"
  | "gateway"
  | "index"
  | "mongo"
  | "shkeeper"
  | "sso"

export interface ServiceConfig<TEnv> {
  enabled?: boolean
  env?: TEnv
}

/** Turns a service's typed env shape into a partial map of string overrides (as passed via `-e` flags). */
type StringEnvOverride<T extends Record<string, string | number>> = Partial<Record<keyof T, string>>

// Note: these are `type` aliases (not `interface`s) on purpose — TS only lets an object type
// satisfy `StringEnvOverride`'s `Record<string, string | number>` constraint when it's a type
// literal, not a named interface (interfaces never get an implicit index signature).

/** ASP.NET-based Etherna services (sso/index/credit/gateway/beehive) share these base keys. */
type BaseAspEnvShape = {
  ASPNETCORE_ENVIRONMENT: string
  "Elastic:Urls:0": string
  ASPNETCORE_Kestrel__Certificates__Default__Path?: string
  ASPNETCORE_Kestrel__Certificates__Default__Password?: string
}

type ElasticEnvShape = {
  "discovery.type": string
  "xpack.security.enabled": string
  ES_JAVA_OPTS: string
}

type BlockchainEnvShape = {
  BLOCKCHAIN_PORT: number
  NETWORK_ID: number
}

type BeeEnvShape = {
  POSTAGE_PRICE: string
  BEE_WARMUP_TIME: string
  BEE_DEBUG_API_ENABLE: string
  BEE_VERBOSITY: string
  BEE_SWAP_ENABLE: string
  BEE_MAINNET: string
  BEE_SWAP_ENDPOINT: string
  BEE_BLOCKCHAIN_RPC_ENDPOINT: string
  BEE_PASSWORD: string
  BEE_SWAP_FACTORY_ADDRESS: string
  BEE_POSTAGE_STAMP_ADDRESS: string
  BEE_PRICE_ORACLE_ADDRESS: string
  BEE_REDISTRIBUTION_ADDRESS: string
  BEE_STAKING_ADDRESS: string
  BEE_POSTAGE_STAMP_START_BLOCK: string
  BEE_NETWORK_ID: number
  BEE_FULL_NODE: string
  BEE_PORT: number
  BEE_P2P_PORT: number
  BEE_API_ADDR: string
  BEE_P2P_ADDR: string
  BEE_CORS_ALLOWED_ORIGINS: string
  BEE_ALLOW_PRIVATE_CIDRS: string
  BEE_BOOTNODE_MODE: string
  BEE_BOOTNODE: string
}

type SsoEnvShape = BaseAspEnvShape & {
  ASPNETCORE_URLS: string
  "IdServer:SsoServer:BaseUrl": string
  "IdServer:SsoServer:AllowUnsafeConnection": string
  "IdServer:Clients:EthernaCredit:BaseUrl": string
  "IdServer:Clients:EthernaGateway:BaseUrls:0": string
  "IdServer:Clients:EthernaIndex:BaseUrl": string
  "IdServer:Clients:EthernaDapp:BaseUrl": string
  "ConnectionStrings:DataProtectionDb": string
  "ConnectionStrings:HangfireDb": string
  "ConnectionStrings:ServiceSharedDb": string
  "ConnectionStrings:SSOServerDb": string
}

type IndexEnvShape = BaseAspEnvShape & {
  ASPNETCORE_URLS: string
  "Swarm:GatewayUrl": string
  "SsoServer:BaseUrl": string
  "SsoServer:AllowUnsafeConnection": string
  "ConnectionStrings:DataProtectionDb": string
  "ConnectionStrings:HangfireDb": string
  "ConnectionStrings:IndexDb": string
  "ConnectionStrings:ServiceSharedDb": string
}

type CreditEnvShape = BaseAspEnvShape & {
  ASPNETCORE_URLS: string
  "SsoServer:BaseUrl": string
  "SsoServer:AllowUnsafeConnection": string
  "ConnectionStrings:DataProtectionDb": string
  "ConnectionStrings:HangfireDb": string
  "ConnectionStrings:CreditDb": string
  "ConnectionStrings:ServiceSharedDb": string
  DisableHttpsRedirection: string
  "Payments:ShKeeper:Url": string
  "Payments:ShKeeper:ApiKey": string
  "Payments:ShKeeper:CustomCallbackBaseUrl": string
}

type GatewayEnvShape = BaseAspEnvShape & {
  ASPNETCORE_URLS: string
  "ForwardedHeaders:KnownNetworks:0": string
  "SsoServer:BaseUrl": string
  "SsoServer:Clients:Credit:BaseUrl": string
  "SsoServer:Clients:Credit:Secret": string
  "SsoServer:Clients:Webapp:Secret": string
  "SsoServer:AllowUnsafeConnection": string
  "Bee:CachedUrl": string
  "Bee:DirectUrl": string
  "Features:GarbageCollectPins": string
  ForwardedAllowedHosts: string
  "ConnectionStrings:DataProtectionDb": string
  "ConnectionStrings:HangfireDb": string
  "ConnectionStrings:GatewayDb": string
  "ConnectionStrings:ServiceSharedDb": string
}

type BeehiveEnvShape = BaseAspEnvShape & {
  ASPNETCORE_URLS: string
  "SeedDb:BeeNodes:0:Hostname": string
  "ConnectionStrings:DataProtectionDb": string
  "ConnectionStrings:HangfireDb": string
  "ConnectionStrings:BeehiveDb": string
  "SeedDb:BeeNodes:0:ConnectionString": string
  "SeedDb:BeeNodes:0:EnableBatchCreation": string
}

type ShkeeperCoreEnvShape = {
  DEV_MODE: string
  BTC_WALLET: string
  LTC_WALLET: string
  DOGE_WALLET: string
  ETH_WALLET: string
  ETH_USERNAME: string
  ETH_PASSWORD: string
  ETHEREUM_API_SERVER_HOST: string
  ETHEREUM_SERVER_PORT: string
  SHKEEPER_BACKEND_KEY: string
  SHKEEPER_BTC_BACKEND_KEY: string
}

type ShkeeperEthereumEnvShape = {
  FULLNODE_URL: string
  FULLNODE_TIMEOUT: string
  CURRENT_ETH_NETWORK: string
  WEB3_ENABLE_POA_MIDDLEWARE: string
  BLOCK_SCANNER_MAX_CATCHUP_BLOCKS: string
  ETH_USERNAME: string
  ETH_PASSWORD: string
  SHKEEPER_BACKEND_KEY: string
  SHKEEPER_HOST: string
  REDIS_HOST: string
  SQLALCHEMY_DATABASE_URI: string
  LAST_BLOCK_LOCKED: string
}

export type ElasticEnv = StringEnvOverride<ElasticEnvShape>
/** Mongo has no fixed env keys today; accepts arbitrary string overrides. */
export type MongoEnv = Partial<Record<string, string>>
/** Combines blockchain + bee container env keys, matching how the plugin builds bee's env today. */
export type BeeEnv = StringEnvOverride<BlockchainEnvShape & BeeEnvShape>
export type SsoEnv = StringEnvOverride<SsoEnvShape>
export type IndexEnv = StringEnvOverride<IndexEnvShape>
export type GatewayEnv = StringEnvOverride<GatewayEnvShape>
export type CreditEnv = StringEnvOverride<CreditEnvShape>
export type BeehiveEnv = StringEnvOverride<BeehiveEnvShape>
export type ShkeeperEnv = StringEnvOverride<ShkeeperCoreEnvShape>
export type ShkeeperEthereumEnv = StringEnvOverride<ShkeeperEthereumEnvShape>

/** Union of env overrides accepted by ASP.NET Etherna containers (SSO, Index, Gateway, Credit, Beehive). */
export type AspServiceEnv = SsoEnv | IndexEnv | GatewayEnv | CreditEnv | BeehiveEnv

/**
 * When `githubRepo` is set (`owner/repo`), builds SHKeeper core from that repository and tags the
 * image as `etherna/shkeeper:…` (same version tag as the default upstream image).
 */
export interface ShkeeperBuildConfig {
  githubRepo?: string
  /** Branch or tag to clone when `githubRepo` is set (defaults to `main`). Ignored for the default upstream build. */
  githubBranch?: string
}

export interface ShkeeperEthereumConfig {
  env?: ShkeeperEthereumEnv
  /** When set, build the adapter from this repo and run `etherna/ethereum-shkeeper:…` instead of the upstream image. */
  githubRepo?: string
  /** Branch or tag to clone when `githubRepo` is set (defaults to `main`). */
  githubBranch?: string
}

export interface ShkeeperConfig extends ServiceConfig<ShkeeperEnv> {
  build?: ShkeeperBuildConfig
  ethereum?: ShkeeperEthereumConfig
}

/** Handle returned by `start`, used to tear the run down (mirrors `EthernaSession.shutdown`). */
export interface EthernaSessionHandle {
  shutdown: (opts?: { killTrackedSpawns?: boolean }) => Promise<void>
}

export interface StartOptions {
  /**
   * When true, reuse already-running service containers, start only missing ones, and do not stop
   * containers on shutdown. Defaults from `ETHERNA_DETACHED` when unset (see `resolveDetachedMode`).
   */
  detached?: boolean
  /** When true, starts Portless and registers friendly `*.localhost` URLs for the app and enabled HTTP services. */
  portless?: boolean
  /** Actual dev-server / app port; CLI and Vite supply this when known. */
  appPort?: number
  /** Installs SIGINT/SIGTERM handlers by default; disable in tests or when the caller manages its own signals. */
  installSignalHandlers?: boolean
  mode?: "http" | "https"
  elastic?: boolean | ServiceConfig<ElasticEnv>
  mongo?: boolean | ServiceConfig<MongoEnv>
  bee?: boolean | ServiceConfig<BeeEnv>
  sso?: boolean | ServiceConfig<SsoEnv>
  index?: boolean | ServiceConfig<IndexEnv>
  gateway?: boolean | ServiceConfig<GatewayEnv>
  credit?: boolean | ServiceConfig<CreditEnv>
  beehive?: boolean | ServiceConfig<BeehiveEnv>
  shkeeper?: boolean | ShkeeperConfig
}

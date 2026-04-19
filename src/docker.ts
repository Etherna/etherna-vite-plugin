import { spawn } from "node:child_process"
import fs from "node:fs"
import chalk from "chalk"

import {
  ensureEthereumShkeeperDockerImage,
  ensureShkeeperDockerImage,
  resolveEthereumShkeeperImageName,
} from "./builder"
import { CERTIFICATE_DIR, CONTAINER_CERTS_DIR } from "./consts"
import {
  BLOCKCHAIN_OWNER_ADDRESS,
  defaultServiceEnvBuildContext,
  getEnv,
  POSTAGE_STAMP_ADMIN_PRIVATE_KEY,
  stripPluginInternalEnvKeys,
} from "./envs"
import { getPortlessPublicUrl, PORTLESS_CONTAINER_ALIASES } from "./portless"
import { trustContainerCertificate } from "./ssl"
import {
  getBeeUnderlayAddress,
  logError,
  logLoading,
  logSuccess,
  resolvePath,
  resolvePathEscape,
} from "./utils"
import {
  decodeUint,
  encodeAddressParam,
  encodeBytes32Param,
  encodeUintParam,
  ethJsonRpc,
  getEthereumBlockNumber,
  getEthereumCode,
  getFunctionSelector,
  isEthereumCodeDeployed,
  privateKeyToAddress,
  sendSignedTransaction,
} from "./web3"

import type {
  AspServiceEnv,
  BeeEnv,
  ElasticEnv,
  MongoEnv,
  ServiceEnvBuildContext,
  ShkeeperEnv,
  ShkeeperEthereumEnv,
} from "./envs"

const BEE_NETWORK_NAME = "etherna_bee_network"
const SHKEEPER_NETWORK_NAME = "etherna_shkeeper_network"

const DOCKER_GET_STARTED_URL = "https://docs.docker.com/get-docker/"
const DOCKER_DAEMON_WAIT_MS = 30_000
const DOCKER_DAEMON_POLL_MS = 2_000
const BEE_CONTRACT_DEPLOY_WAIT_MS = 30_000
const BEE_CONTRACT_DEPLOY_POLL_MS = 1_000
const BEE_CORRUPTED_CHAIN_BLOCK_THRESHOLD = 10
const BEE_CORRUPTED_CHAIN_PROGRESS_BLOCKS = 2

const BEE_REQUIRED_CONTRACT_ENV_KEYS = [
  "BEE_SWAP_FACTORY_ADDRESS",
  "BEE_POSTAGE_STAMP_ADDRESS",
  "BEE_PRICE_ORACLE_ADDRESS",
  "BEE_REDISTRIBUTION_ADDRESS",
  "BEE_STAKING_ADDRESS",
] as const

const POSTAGE_PRICE_SYNC_TIMEOUT_MS = 30_000
const POSTAGE_PRICE_SYNC_POLL_MS = 500
const POSTAGE_PRICE_SYNC_GAS_LIMIT = 200_000

let blockchainBootstrapInProgress = false
let resolveBlockchainBootstrapSettle = undefined as undefined | (() => void)
let blockchainBootstrapSettlePromise = Promise.resolve()

function beginBlockchainBootstrap() {
  blockchainBootstrapInProgress = true
  blockchainBootstrapSettlePromise = new Promise<void>((resolve) => {
    resolveBlockchainBootstrapSettle = resolve
  })
}

function settleBlockchainBootstrap() {
  if (!blockchainBootstrapInProgress) {
    return
  }

  blockchainBootstrapInProgress = false
  resolveBlockchainBootstrapSettle?.()
  resolveBlockchainBootstrapSettle = undefined
}

export function isBlockchainBootstrapInProgress() {
  return blockchainBootstrapInProgress
}

export function waitForBlockchainBootstrapToSettle() {
  return blockchainBootstrapSettlePromise
}

function spawnDetached(command: string, args: string[]) {
  const proc = spawn(command, args, { detached: true, stdio: "ignore" })
  proc.unref()
}

/** Resolves when `docker info` succeeds (daemon reachable). */
function isDockerDaemonRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["info"], { stdio: "ignore" })
    proc.on("error", () => resolve(false))
    proc.on("exit", (code) => resolve(code === 0))
  })
}

/** True when the Docker CLI is on PATH and runs. */
function isDockerCliInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["--version"], { stdio: "ignore" })
    proc.on("error", () => resolve(false))
    proc.on("exit", (code) => resolve(code === 0))
  })
}

function tryStartDockerDaemon() {
  const { platform } = process

  if (platform === "darwin") {
    spawnDetached("open", ["-a", "Docker"])
    return
  }

  if (platform === "win32") {
    const exe = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"
    if (fs.existsSync(exe)) {
      spawnDetached(exe, [])
      return
    }
    spawnDetached("cmd", ["/c", "start", "", "Docker Desktop"])
    return
  }

  if (platform === "linux") {
    spawnDetached("systemctl", ["--user", "start", "docker-desktop"])
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * Reads `PostageStamp.lastPrice()` (the value Bee uses for stamp accounting)
 * and, if it differs from `desiredPrice`, writes the new price by calling
 * `PostageStamp.setPrice(uint256)` directly from the deployer key — bypassing
 * the broken `PostagePriceOracle` shipped by fdp-play.
 *
 * Why we bypass `PostagePriceOracle`:
 * fdp-play's `deploy.ts` calls `getPostagePriceOracleBin(erc20Address, adminAddress)`
 * which appends BOTH addresses to the constructor calldata, but the actual
 * `PriceOracle` constructor only takes one arg (`address _postageStamp`).
 * Solidity silently ignores the trailing word, so the deployed oracle's
 * `postageStamp` field ends up pointing at the BZZ token contract, not the
 * real `PostageStamp`. Every `oracle.setPrice(...)` then internally calls
 * `bzzToken.setPrice(...)`, which doesn't exist — depending on the exact
 * deployed bytecode the outer tx either reverts or quietly succeeds while
 * `PostageStamp.lastPrice` stays at 0. Either way, no role grant on the
 * oracle can fix it.
 *
 * Direct `PostageStamp.setPrice(uint256)` call requires `PRICE_ORACLE_ROLE`.
 * We grant it to the deployer first (deployer holds `DEFAULT_ADMIN_ROLE` on
 * `PostageStamp`, set by its constructor's `_setupRole(DEFAULT_ADMIN_ROLE,
 * msg.sender)`). The role hash is read from the contract itself
 * (`PRICE_ORACLE_ROLE()` getter) so we transparently support both v0.5.x
 * (`keccak256("PRICE_ORACLE")`) and v0.6.x (`keccak256("PRICE_ORACLE_ROLE")`)
 * bytecodes.
 *
 * `ownerPrivateKey` MUST be the key that originally deployed `PostageStamp`
 * (matching fdp-play's `hardhat.config.ts`). The unlocked Clique signer never
 * deployed any contract and therefore lacks `DEFAULT_ADMIN_ROLE` everywhere.
 * We can't go through geth's `personal_*` API either (removed from the HTTP
 * namespace in geth ≥ 1.12), so txs are signed locally with EIP-155 and
 * broadcast via `eth_sendRawTransaction`.
 */
async function ensurePostagePrice({
  rpcUrl,
  postageStampAddress,
  ownerPrivateKey,
  desiredPrice,
}: {
  rpcUrl: string
  postageStampAddress: string
  ownerPrivateKey: string
  desiredPrice: bigint
}): Promise<void> {
  const name = "etherna-bee"
  // PostageStamp stores `lastPrice` as uint64.
  const maxPrice = (1n << 64n) - 1n
  if (desiredPrice < 0n || desiredPrice > maxPrice) {
    throw new Error(`POSTAGE_PRICE ${desiredPrice} is out of range for uint64 (0..${maxPrice}).`)
  }

  const [
    lastPriceSelector,
    setPriceSelector,
    hasRoleSelector,
    grantRoleSelector,
    priceOracleRoleSelector,
  ] = await Promise.all([
    getFunctionSelector(rpcUrl, "lastPrice()"),
    getFunctionSelector(rpcUrl, "setPrice(uint256)"),
    getFunctionSelector(rpcUrl, "hasRole(bytes32,address)"),
    getFunctionSelector(rpcUrl, "grantRole(bytes32,address)"),
    getFunctionSelector(rpcUrl, "PRICE_ORACLE_ROLE()"),
  ])

  const readLastPrice = async () => {
    const raw = await ethJsonRpc<string>(rpcUrl, "eth_call", [
      { to: postageStampAddress, data: lastPriceSelector },
      "latest",
    ])
    return decodeUint(raw)
  }

  const currentPrice = await readLastPrice()

  if (currentPrice === desiredPrice) {
    console.log(
      `  ${chalk.green("➜")}  ${chalk.bold(name)}:   postage price already at ${chalk.cyan(
        String(desiredPrice),
      )} PLUR`,
    )
    return
  }

  const ownerAddress = privateKeyToAddress(ownerPrivateKey)

  const roleHashRaw = await ethJsonRpc<string>(rpcUrl, "eth_call", [
    { to: postageStampAddress, data: priceOracleRoleSelector },
    "latest",
  ])
  if (!roleHashRaw || roleHashRaw === "0x") {
    throw new Error(
      `PostageStamp.PRICE_ORACLE_ROLE() returned no data; ${postageStampAddress} may not be a PostageStamp contract.`,
    )
  }
  const roleHashEncoded = encodeBytes32Param(roleHashRaw)
  const ownerAddressEncoded = encodeAddressParam(ownerAddress)

  const hasRoleRaw = await ethJsonRpc<string>(rpcUrl, "eth_call", [
    {
      to: postageStampAddress,
      data: hasRoleSelector + roleHashEncoded + ownerAddressEncoded,
    },
    "latest",
  ])
  const ownerHasRole = decodeUint(hasRoleRaw) !== 0n

  if (!ownerHasRole) {
    console.log(
      `  ${chalk.yellow("➜")}  ${chalk.bold(
        name,
      )}:   granting PRICE_ORACLE_ROLE on PostageStamp to ${chalk.gray(ownerAddress)}`,
    )
    const grantTxHash = await sendSignedTransaction(
      rpcUrl,
      ownerPrivateKey,
      {
        to: postageStampAddress,
        data: grantRoleSelector + roleHashEncoded + ownerAddressEncoded,
        gasLimit: BigInt(POSTAGE_PRICE_SYNC_GAS_LIMIT),
      },
      {
        timeoutMs: POSTAGE_PRICE_SYNC_TIMEOUT_MS,
        pollMs: POSTAGE_PRICE_SYNC_POLL_MS,
        onRevert: (hash) =>
          `PostageStamp.grantRole(PRICE_ORACLE_ROLE, ${ownerAddress}) reverted (tx ${hash}). The owner likely lacks DEFAULT_ADMIN_ROLE on PostageStamp ${postageStampAddress}.`,
      },
    )
    console.log(`  ${chalk.gray(`  granted (tx ${grantTxHash})`)}`)
  }

  console.log(
    `  ${chalk.yellow("➜")}  ${chalk.bold(name)}:   updating postage price ${chalk.gray(
      String(currentPrice),
    )} → ${chalk.cyan(String(desiredPrice))} PLUR`,
  )

  const txHash = await sendSignedTransaction(
    rpcUrl,
    ownerPrivateKey,
    {
      to: postageStampAddress,
      data: setPriceSelector + encodeUintParam(desiredPrice),
      gasLimit: BigInt(POSTAGE_PRICE_SYNC_GAS_LIMIT),
    },
    {
      timeoutMs: POSTAGE_PRICE_SYNC_TIMEOUT_MS,
      pollMs: POSTAGE_PRICE_SYNC_POLL_MS,
      onRevert: (hash) =>
        `PostageStamp.setPrice(${desiredPrice}) reverted (tx ${hash}). The owner ${ownerAddress} may lack PRICE_ORACLE_ROLE on PostageStamp ${postageStampAddress}.`,
    },
  )

  const newPrice = await readLastPrice()
  if (newPrice !== desiredPrice) {
    throw new Error(
      `PostageStamp.setPrice(${desiredPrice}) succeeded (tx ${txHash}) but PostageStamp.lastPrice is ${newPrice}.`,
    )
  }

  console.log(
    `  ${chalk.green("➜")}  ${chalk.bold(name)}:   postage price set to ${chalk.cyan(
      String(desiredPrice),
    )} PLUR ${chalk.gray(`(tx ${txHash})`)}`,
  )
}

function createCorruptedBlockchainError(volumeName: string) {
  return new Error(
    [
      "Detected a stale or corrupted local blockchain state: Bee contracts are still missing even though the chain has already advanced.",
      "Fix it by stopping the dev server, removing the persisted blockchain volume, and starting again:",
      `1. Stop the dev server`,
      `2. Run: docker volume rm ${volumeName}`,
      `3. Run: pnpm dev`,
    ].join("\n"),
  )
}

async function waitForBeeContracts(rpcUrl: string, addresses: string[], volumeName: string) {
  const deadline = Date.now() + BEE_CONTRACT_DEPLOY_WAIT_MS
  let firstObservedBlock: number | null = null

  while (Date.now() < deadline) {
    const [blockNumber, codes] = await Promise.all([
      getEthereumBlockNumber(rpcUrl).catch(() => null),
      Promise.all(addresses.map((address) => getEthereumCode(rpcUrl, address).catch(() => null))),
    ])

    if (blockNumber != null && codes.every((code) => code != null)) {
      if (firstObservedBlock === null) {
        firstObservedBlock = blockNumber
      }

      if (codes.every((code) => isEthereumCodeDeployed(code))) {
        return
      }

      const blockchainLooksCorrupted =
        blockNumber >= BEE_CORRUPTED_CHAIN_BLOCK_THRESHOLD ||
        blockNumber - firstObservedBlock >= BEE_CORRUPTED_CHAIN_PROGRESS_BLOCKS

      if (blockchainLooksCorrupted) {
        throw createCorruptedBlockchainError(volumeName)
      }
    }

    await sleep(BEE_CONTRACT_DEPLOY_POLL_MS)
  }

  throw new Error(
    `Bee contracts were not deployed before the startup timeout elapsed. If this keeps happening, stop the dev server, run \`docker volume rm ${volumeName}\`, and start again.`,
  )
}

/**
 * Verifies Docker CLI is installed, starts the daemon when possible, and waits until it responds.
 * Exits the process on unrecoverable errors.
 */
export async function ensureDockerReady() {
  const cliOk = await isDockerCliInstalled()
  if (!cliOk) {
    console.error(
      `  ${chalk.red("x")}  ${chalk.bold("docker")}:   ${chalk.red("Docker is not installed or not on your PATH.")}`,
    )
    console.error(
      `     Install Docker and try again: ${chalk.cyan.underline(DOCKER_GET_STARTED_URL)}`,
    )
    process.exit(1)
  }

  if (await isDockerDaemonRunning()) {
    return
  }

  console.log(
    `  ${chalk.yellow("➜")}  ${chalk.bold("docker")}:   ${chalk.yellow("Docker daemon is not running. Starting it…")}`,
  )
  tryStartDockerDaemon()

  const deadline = Date.now() + DOCKER_DAEMON_WAIT_MS
  while (Date.now() < deadline) {
    await sleep(DOCKER_DAEMON_POLL_MS)
    if (await isDockerDaemonRunning()) {
      console.log(
        `  ${chalk.green("➜")}  ${chalk.bold("docker")}:   ${chalk.green("Docker is ready.")}`,
      )
      return
    }
  }

  console.error(
    `  ${chalk.red("x")}  ${chalk.bold("docker")}:   ${chalk.red(
      `Docker did not become ready within ${DOCKER_DAEMON_WAIT_MS / 1000}s. Start Docker manually and run the dev server again.`,
    )}`,
  )
  console.error(`     Install or troubleshoot: ${chalk.cyan.underline(DOCKER_GET_STARTED_URL)}`)
  process.exit(1)
}

export async function startDockerContainer({
  containerName,
  imageName,
  args = [],
  cmd = [],
}: {
  containerName: string
  imageName: string
  args?: string[]
  cmd?: string[]
}) {
  if (await isContainerNameInUse(containerName)) {
    await stopContainer(containerName)
  }

  const proc = spawn("docker", ["run", "--rm", "--name", containerName, ...args, imageName, ...cmd])
  proc.stdout.on("data", (data) => {
    const text = String(data)

    if (/Pulling from/gm.test(text)) {
      logLoading(containerName)
    }
    if (/Error response from daemon/gm.test(text)) {
      logError(containerName, text)
    }
  })

  return proc
}

export async function startMongoDbContainer(envs?: MongoEnv, context?: ServiceEnvBuildContext) {
  const name = "etherna-mongodb"
  const dbVolumeName = `etherna_${name}-db-volume`
  const configDbVolumeName = `etherna_${name}-configdb-volume`
  await Promise.all([
    createContainerVolume(dbVolumeName),
    createContainerVolume(configDbVolumeName),
  ])

  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  const ctx = context ?? defaultServiceEnvBuildContext("http")
  const env = {
    ...(getEnv(name, ctx) ?? {}),
    ...envs,
  }

  const proc = await startDockerContainer({
    containerName: name,
    imageName: "mongo:latest",
    args: [
      ...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`]),
      "--mount",
      `type=volume,source=${dbVolumeName},target=/data/db`,
      "--mount",
      `type=volume,source=${configDbVolumeName},target=/data/configdb`,
      "--network",
      "host",
    ],
    cmd: [],
  })

  const handleStdData = (data: unknown) => {
    const text = String(data)
    if (/mongod startup complete/gm.test(text)) {
      logSuccess(name, "mongodb", "27017")
      endPromise?.()
    }
  }

  proc.stdout.on("data", handleStdData)
  proc.stdout.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    endPromise?.()
  })
  proc.stderr.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, `Container closed with code ${code}`)
    endPromise?.()
    proc.kill()
  })

  await promise

  return proc
}

export async function startElasticContainer(envs?: ElasticEnv, context?: ServiceEnvBuildContext) {
  const name = "elastic"
  const dataVolumeName = `etherna_${name}-data-volume`
  await createContainerVolume(dataVolumeName)

  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  const ctx = context ?? defaultServiceEnvBuildContext("http")
  const env = {
    ...(getEnv(name, ctx) ?? {}),
    ...envs,
  }

  const proc = await startDockerContainer({
    containerName: name,
    imageName: "elasticsearch:7.17.24",
    args: [
      ...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`]),
      "--mount",
      `type=volume,source=${dataVolumeName},target=/usr/share/elasticsearch/data`,
      "--network",
      "host",
      "--memory=512m",
    ],
    cmd: [],
  })

  const handleStdData = (data: unknown) => {
    const text = String(data)
    if (/"message": "started"/gm.test(text)) {
      logSuccess(name, "http", "9200")
      endPromise?.()
    }
  }

  proc.stdout.on("data", handleStdData)
  proc.stdout.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    endPromise?.()
  })
  proc.stderr.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, `Container closed with code ${code}`)
    endPromise?.()
    proc.kill()
  })

  await promise

  return proc
}

export async function startAspContainer(
  name: string,
  image: string,
  context: ServiceEnvBuildContext,
  envs?: AspServiceEnv,
) {
  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  let lastLog: string | undefined = undefined

  const { mode } = context
  const env = {
    ...(getEnv(name as "etherna-sso", context) ?? {}),
    ...envs,
  }
  const port = env.ASPNETCORE_URLS.split(";")[0]?.split(":")[2] ?? "80"

  const alias = PORTLESS_CONTAINER_ALIASES[name]
  const portlessUrl = context.portless && alias ? getPortlessPublicUrl(alias) : undefined

  const proc = await startDockerContainer({
    containerName: name,
    imageName: image,
    args: [
      ...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`]),
      ...(mode === "https"
        ? [
            "--mount",
            `type=bind,source=${resolvePathEscape(CERTIFICATE_DIR)},target=${CONTAINER_CERTS_DIR}/`,
          ]
        : []),
      "--network",
      "host",
    ],
  })

  const handleStdData = async (data: unknown) => {
    lastLog = undefined

    const text = String(data)

    if (/Now listening on: https?:\/\/(localhost|\[::\]):\d+/gm.test(text)) {
      if (mode === "https") {
        await trustContainerCertificate(name)
      }
      logSuccess(name, mode, port, { portlessUrl })
      endPromise?.()
    }

    const excludedErrorRegexes = [
      /Current db does not support change stream/gm,
      /is only supported on replica sets./gm,
      /Failed to process the job/gm,
    ]
    // Etherna ASP.NET apps use Serilog; default format: [HH:mm:ss INF] message
    // Require explicit error level - logs can arrive in chunks, so a chunk with
    // Exception but no level may be the continuation of a [WRN] log
    const errorLogLevelRegexes = [
      /\[(ERR|FTL)\]/gm, // Serilog {Level:u3}
      /"LogLevel"\s*:\s*"(Error|Critical)"/gm, // Microsoft JSON
      /\b(fail|crit):/gm, // Microsoft Simple
      /<(2|3)>/gm, // Microsoft Systemd: <2>=Critical, <3>=Error
    ]
    const hasErrorLevel = errorLogLevelRegexes.some((regex) => regex.test(text))
    const hasNonErrorLevel = /\[(INF|WRN|DBG|VRB)\]/gm.test(text)
    if (
      hasErrorLevel &&
      !hasNonErrorLevel &&
      /Exception:.+/gm.test(text) &&
      !excludedErrorRegexes.some((regex) => regex.test(text))
    ) {
      logError(name, text)
      endPromise?.()
    } else {
      lastLog = text
    }
  }

  proc.stdout.on("data", handleStdData)
  proc.stdout.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    endPromise?.()
  })
  proc.stderr.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, lastLog || `Container closed with code ${code}`)
    endPromise?.()
    proc.kill()
  })

  await promise

  return proc
}

export async function startBlockchain(context: ServiceEnvBuildContext, envs?: BeeEnv) {
  const name = "etherna-blockchain"
  const volumeName = "etherna_blockchain-volume"

  beginBlockchainBootstrap()
  await createNetwork(BEE_NETWORK_NAME)
  await createContainerVolume(volumeName)

  let lastLog: string | undefined = undefined
  let endPromise = undefined as undefined | (() => void)
  let rejectPromise = undefined as undefined | ((reason?: unknown) => void)
  const promise = new Promise<void>((res, rej) => {
    endPromise = res
    rejectPromise = rej
  })
  let readinessCheckStarted = false
  let startupSettled = false

  if (!fs.existsSync(resolvePath(".ethereum"))) {
    fs.mkdirSync(resolvePath(".ethereum"), { recursive: true, mode: 0o777 })
  }
  if (!fs.existsSync(resolvePath(".ethereum", "password"))) {
    fs.writeFileSync(resolvePath(".ethereum", "password"), "toTheSun", {
      encoding: "utf-8",
      mode: 0o644,
    })
  }

  const env = stripPluginInternalEnvKeys({
    ...(getEnv(name, context) ?? {}),
    ...envs,
  })
  const beeEnv = {
    ...(getEnv("etherna-bee", context) ?? {}),
    ...envs,
  }

  const blockchainPort = Number(env.BLOCKCHAIN_PORT)
  const beeContractAddresses = BEE_REQUIRED_CONTRACT_ENV_KEYS.map((key) => String(beeEnv[key]))

  const proc = await startDockerContainer({
    containerName: name,
    imageName: "fairdatasociety/fdp-play-blockchain:latest",
    args: [
      ...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`]),
      "--network",
      BEE_NETWORK_NAME,
      "-p",
      `${blockchainPort}:${blockchainPort}`,
      "-p",
      `${blockchainPort + 1}:${blockchainPort + 1}`,
      "--mount",
      `type=volume,source=${volumeName},target=/root/.ethereum`,
      "--mount",
      `type=bind,source=${resolvePathEscape(".ethereum")},target=/root/extra`,
    ],
    cmd: [
      "--allow-insecure-unlock",
      `--unlock=${BLOCKCHAIN_OWNER_ADDRESS}`,
      "--password=/root/extra/password",
      "--mine",
      `--miner.etherbase=${BLOCKCHAIN_OWNER_ADDRESS}`,
      "--http",
      '--http.api="debug,web3,eth,txpool,net,personal"',
      "--http.corsdomain=*",
      `--http.port=${blockchainPort}`,
      "--http.addr=0.0.0.0",
      "--http.vhosts=*",
      "--ws",
      '--ws.api="debug,web3,eth,txpool,net,personal"',
      `--ws.port=${blockchainPort + 1}`,
      "--ws.origins=*",
      "--maxpeers=0",
      `--networkid=${env.NETWORK_ID}`,
      "--authrpc.vhosts=*",
      "--authrpc.addr=0.0.0.0",
    ],
  })

  const handleStdData = (data: unknown) => {
    lastLog = undefined

    const text = String(data)
    if (!readinessCheckStarted && /HTTP server started/gm.test(text)) {
      readinessCheckStarted = true
      void waitForBeeContracts(
        `http://127.0.0.1:${blockchainPort}`,
        beeContractAddresses,
        volumeName,
      )
        .then(() => {
          startupSettled = true
          settleBlockchainBootstrap()
          endPromise?.()
        })
        .catch((error: unknown) => {
          startupSettled = true
          settleBlockchainBootstrap()
          const message = error instanceof Error ? error.message : String(error)
          logError(name, message)
          void stopContainer(name).finally(() => {
            rejectPromise?.(error)
          })
        })
    }

    if (/Error:.+/gm.test(text)) {
      logError(name, text)
      endPromise?.()
    } else {
      lastLog = text
    }
  }

  proc.stdout.on("data", handleStdData)
  proc.stdout.on("error", (error) => {
    settleBlockchainBootstrap()
    logError(name, "FATAL: " + error.message)
    endPromise?.()
  })
  proc.stderr.on("data", handleStdData)
  proc.on("close", (code) => {
    settleBlockchainBootstrap()
    if (!startupSettled) {
      logError(name, lastLog || `Container closed with code ${code}`)
      endPromise?.()
    }
    proc.kill()
  })

  await promise

  return proc
}

export async function startBeeNodes(context: ServiceEnvBuildContext, envs?: BeeEnv) {
  const name = "etherna-bee"

  const queenProc = await startBeeNode(name, context, undefined, undefined, envs)

  const bootnode = await getBeeUnderlayAddress(
    `http://localhost:${getEnv("etherna-bee", context)?.BEE_PORT ?? "1633"}`,
  )

  const [worker1Proc] = await Promise.all([
    startBeeNode(name, context, 1, bootnode, envs),
    // startBeeNode(name, mode, 2, bootnode, envs),
    // startBeeNode(name, mode, 3, bootnode, envs),
    // startBeeNode(name, mode, 4, bootnode, envs),
  ])

  try {
    const beeEnv = { ...(getEnv("etherna-bee", context) ?? {}), ...envs }
    const blockchainEnv = {
      ...(getEnv("etherna-blockchain", context) ?? {}),
      ...envs,
    }
    await ensurePostagePrice({
      rpcUrl: `http://127.0.0.1:${blockchainEnv.BLOCKCHAIN_PORT}`,
      postageStampAddress: String(beeEnv.BEE_POSTAGE_STAMP_ADDRESS),
      ownerPrivateKey: POSTAGE_STAMP_ADMIN_PRIVATE_KEY,
      desiredPrice: BigInt(String(beeEnv.POSTAGE_PRICE ?? "24000")),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError(name, `Failed to sync postage price: ${message}`)
  }

  return [queenProc, worker1Proc]
}

export async function startBeeNode(
  name: string,
  context: ServiceEnvBuildContext,
  worker?: 1 | 2 | 3 | 4,
  bootnode?: string,
  envs?: BeeEnv,
) {
  const volumeName = worker ? `etherna_bee_worker_${worker}-volume` : "etherna_bee-volume"
  await createContainerVolume(volumeName)

  let lastLog: string | undefined = undefined
  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  const { mode } = context
  const env = stripPluginInternalEnvKeys({
    ...(getEnv(name, context) ?? {}),
    ...envs,
  })

  if (!worker) {
    delete env.BEE_BOOTNODE
    env.BEE_BOOTNODE_MODE = "false"
  } else {
    delete env.BEE_BOOTNODE_MODE
    env.BEE_BOOTNODE = bootnode
  }

  if (worker) {
    name = `${name}_worker_${worker}`
  }

  const proc = await startDockerContainer({
    containerName: name,
    imageName: worker
      ? `fairdatasociety/fdp-play-worker-${worker}`
      : "fairdatasociety/fdp-play-queen:latest",
    args: [
      ...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`]),
      "--mount",
      `type=volume,source=${volumeName},target=/home/bee/.bee`,
      "--network",
      BEE_NETWORK_NAME,
      "-p",
      `${worker ? parseInt(env.BEE_PORT ?? "1633") + worker * 10000 : env.BEE_PORT}:${env.BEE_PORT}`,
      "-p",
      `${worker ? parseInt(env.BEE_P2P_PORT ?? "1634") + worker * 10000 : env.BEE_P2P_PORT}:${env.BEE_P2P_PORT}`,
    ],
    cmd: ["start"],
  })
  const handleStdData = (data: unknown) => {
    lastLog = undefined

    const text = String(data)
    if (/"address"="\[::\]:\d+"/gm.test(text)) {
      if (!worker) {
        const portlessUrl = context.portless ? getPortlessPublicUrl("bee") : undefined
        logSuccess(name, mode, String(env.BEE_PORT ?? "1633"), { portlessUrl })
      }
      endPromise?.()
    }

    const excludedErrorRegexes = [/"logger"="node\/storageincentives"/gm]
    // Bee uses "level"="error" format; filter to only error/critical lines (chunks can mix levels)
    const errorLines = text.split("\n").filter((line) => /"level"="(error|critical)"/.test(line))
    const errorText = errorLines.join("\n")
    if (errorText && !excludedErrorRegexes.some((regex) => regex.test(text))) {
      logError(name, errorText)
      endPromise?.()
      lastLog = errorText
    }
  }

  proc.stdout.on("data", handleStdData)
  proc.stdout.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    endPromise?.()
  })
  proc.stderr.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, lastLog || `Container closed with code ${code}`)
    endPromise?.()
    proc.kill()
  })

  await promise

  return proc
}

export async function startInterceptor(name: string, context: ServiceEnvBuildContext) {
  let lastLog: string | undefined = undefined
  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  const env = getEnv(name, context) ?? {}

  const proc = await startDockerContainer({
    containerName: name,
    imageName: "etherna/etherna-gateway-interceptor:latest",
    args: [...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`])],
  })
  const handleStdData = (data: unknown) => {
    lastLog = undefined

    const text = String(data)
    if (/starting in full mode/gm.test(text)) {
      endPromise?.()
    }

    if (/"level"="error"/gm.test(text)) {
      logError(name, text)
      endPromise?.()
    } else {
      lastLog = text
    }
  }

  proc.stdout.on("data", handleStdData)
  proc.stdout.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    endPromise?.()
  })
  proc.stderr.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, lastLog || `Container closed with code ${code}`)
    endPromise?.()
    proc.kill()
  })

  await promise

  return proc
}

async function isContainerNameInUse(name: string) {
  const proc = spawn("docker", ["ps", "-a", "--filter", `name=${name}`])
  const result = await new Promise<string>((res) => {
    let data = ""
    proc.stdout.on("data", (d) => {
      data += String(d)
    })
    proc.on("close", () => {
      res(data)
    })
  })
  const lines = result.split("\n")
  const isInUse = lines.length > 1
  return isInUse
}

async function stopContainer(name: string) {
  const proc = spawn("docker", ["stop", name])
  await new Promise<void>((res) => {
    proc.on("close", () => {
      res()
    })
  })
}

async function createContainerVolume(volumeName: string) {
  const proc = spawn("docker", ["volume", "create", volumeName])

  await new Promise<void>((res) => {
    proc.on("close", () => {
      res()
    })
  })
}

async function createNetwork(networkName: string) {
  const proc = spawn("docker", ["network", "create", networkName])

  await new Promise<void>((res) => {
    proc.on("close", () => {
      res()
    })
  })
}

export async function startShkeeperCoreContainer({
  context,
  envs,
  build,
  networkName,
}: {
  context: ServiceEnvBuildContext
  envs?: ShkeeperEnv
  build: {
    imageName: string
  }
  networkName: string
}) {
  const name = "shkeeper"
  const instanceVolumeName = "etherna_shkeeper-instance-volume"
  await createContainerVolume(instanceVolumeName)

  let endPromise = undefined as undefined | (() => void)
  let rejectPromise = undefined as undefined | ((reason?: unknown) => void)
  const promise = new Promise<void>((res, rej) => {
    endPromise = res
    rejectPromise = rej
  })

  let lastLog: string | undefined = undefined
  let ready = false
  const env = {
    ...(getEnv("shkeeper-core", context) ?? {}),
    ...envs,
  }
  const port = String(getEnv("shkeeper", context)?.port ?? "32650")
  const useHostNetwork = networkName === "host"
  const listenPort = useHostNetwork ? port : "5000"

  const proc = await startDockerContainer({
    containerName: name,
    imageName: build.imageName,
    args: [
      ...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`]),
      "--mount",
      `type=volume,source=${instanceVolumeName},target=/shkeeper.io/instance`,
      "--network",
      networkName,
      ...(useHostNetwork ? [] : ["-p", `${port}:5000`]),
    ],
    ...(useHostNetwork
      ? {
          cmd: [
            "bash",
            "-c",
            `gunicorn --access-logfile=- --workers=1 --threads=16 --timeout=600 --bind=0.0.0.0:${port} 'shkeeper:create_app()'`,
          ],
        }
      : {}),
  })

  const handleStdData = (data: unknown) => {
    lastLog = undefined

    const text = String(data)
    if (new RegExp(`Listening at: http://.+:${listenPort}`, "gm").test(text)) {
      ready = true
      logSuccess(name, "http", port)
      endPromise?.()
    } else {
      lastLog = text
    }
  }

  proc.stdout.on("data", handleStdData)
  proc.stdout.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    if (!ready) {
      rejectPromise?.(error)
    }
  })
  proc.stderr.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, lastLog || `Container closed with code ${code}`)
    if (!ready) {
      rejectPromise?.(new Error(`Container closed with code ${code}`))
    }
    proc.kill()
  })

  await promise

  return proc
}

export async function startShkeeperEthereumApiContainer({
  context,
  envs,
  networkName,
  imageName,
}: {
  context: ServiceEnvBuildContext
  envs?: ShkeeperEthereumEnv
  networkName: string
  imageName: string
}) {
  const name = "ethereum-shkeeper"
  let endPromise = undefined as undefined | (() => void)
  let rejectPromise = undefined as undefined | ((reason?: unknown) => void)
  const promise = new Promise<void>((res, rej) => {
    endPromise = res
    rejectPromise = rej
  })

  let lastLog: string | undefined = undefined
  let ready = false
  const env = {
    ...(getEnv("ethereum-shkeeper", context) ?? {}),
    ...envs,
  }

  const proc = await startDockerContainer({
    containerName: name,
    imageName,
    args: [
      ...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`]),
      "--network",
      networkName,
    ],
    cmd: [
      "bash",
      "-c",
      "sleep 30 && gunicorn --access-logfile=- --workers=1 --threads=16 --timeout=600 --bind=0.0.0.0:6000 run:server",
    ],
  })

  const handleStdData = (data: unknown) => {
    lastLog = undefined

    const text = String(data)
    if (/Listening at: http:\/\/.+:6000/gm.test(text)) {
      ready = true
      endPromise?.()
    } else {
      lastLog = text
    }
  }

  proc.stdout.on("data", handleStdData)
  proc.stdout.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    if (!ready) {
      rejectPromise?.(error)
    }
  })
  proc.stderr.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, lastLog || `Container closed with code ${code}`)
    if (!ready) {
      rejectPromise?.(new Error(`Container closed with code ${code}`))
    }
    proc.kill()
  })

  await promise

  return proc
}

export async function startShkeeperMariaDbContainer(networkName = SHKEEPER_NETWORK_NAME) {
  const name = "ethereum-shkeeper-mariadb"
  const volumeName = "etherna_shkeeper-mariadb-volume"
  await createContainerVolume(volumeName)

  let endPromise = undefined as undefined | (() => void)
  let rejectPromise = undefined as undefined | ((reason?: unknown) => void)
  const promise = new Promise<void>((res, rej) => {
    endPromise = res
    rejectPromise = rej
  })

  let lastLog: string | undefined = undefined
  let ready = false
  const proc = await startDockerContainer({
    containerName: name,
    imageName: "mariadb:10.9.3",
    args: [
      "-e",
      "MARIADB_ROOT_PASSWORD=shkeeper",
      "-e",
      "MARIADB_DATABASE=ethereum-shkeeper",
      "--mount",
      `type=volume,source=${volumeName},target=/var/lib/mysql`,
      "--network",
      networkName,
    ],
  })

  const handleStdData = (data: unknown) => {
    lastLog = undefined

    const text = String(data)
    if (/ready for connections/gim.test(text)) {
      ready = true
      endPromise?.()
    } else {
      lastLog = text
    }
  }

  proc.stdout.on("data", handleStdData)
  proc.stdout.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    if (!ready) {
      rejectPromise?.(error)
    }
  })
  proc.stderr.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, lastLog || `Container closed with code ${code}`)
    if (!ready) {
      rejectPromise?.(new Error(`Container closed with code ${code}`))
    }
    proc.kill()
  })

  await promise

  return proc
}

export async function startShkeeperRedisContainer(networkName = SHKEEPER_NETWORK_NAME) {
  const name = "ethereum-shkeeper-redis"
  const volumeName = "etherna_shkeeper-redis-volume"
  await createContainerVolume(volumeName)

  let endPromise = undefined as undefined | (() => void)
  let rejectPromise = undefined as undefined | ((reason?: unknown) => void)
  const promise = new Promise<void>((res, rej) => {
    endPromise = res
    rejectPromise = rej
  })

  let lastLog: string | undefined = undefined
  let ready = false
  const proc = await startDockerContainer({
    containerName: name,
    imageName: "redis:7",
    args: ["--mount", `type=volume,source=${volumeName},target=/data`, "--network", networkName],
  })

  const handleStdData = (data: unknown) => {
    lastLog = undefined

    const text = String(data)
    if (/Ready to accept connections/gm.test(text)) {
      ready = true
      endPromise?.()
    } else {
      lastLog = text
    }
  }

  proc.stdout.on("data", handleStdData)
  proc.stdout.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    if (!ready) {
      rejectPromise?.(error)
    }
  })
  proc.stderr.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, lastLog || `Container closed with code ${code}`)
    if (!ready) {
      rejectPromise?.(new Error(`Container closed with code ${code}`))
    }
    proc.kill()
  })

  await promise

  return proc
}

export async function startShkeeperEthereumTasksContainer({
  context,
  envs,
  networkName,
  imageName,
}: {
  context: ServiceEnvBuildContext
  envs?: ShkeeperEthereumEnv
  networkName: string
  imageName: string
}) {
  const name = "ethereum-tasks"
  let endPromise = undefined as undefined | (() => void)
  let rejectPromise = undefined as undefined | ((reason?: unknown) => void)
  const promise = new Promise<void>((res, rej) => {
    endPromise = res
    rejectPromise = rej
  })

  let lastLog: string | undefined = undefined
  let ready = false
  const env = {
    ...(getEnv("ethereum-shkeeper", context) ?? {}),
    ...envs,
    C_FORCE_ROOT: "1",
  }

  const proc = await startDockerContainer({
    containerName: name,
    imageName,
    args: [
      ...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`]),
      "--network",
      networkName,
    ],
    cmd: ["bash", "-c", "sleep 30 && celery -A celery_worker.celery worker --loglevel=info -B"],
  })

  const handleStdData = (data: unknown) => {
    lastLog = undefined

    const text = String(data)
    if (/ready\./gim.test(text)) {
      ready = true
      endPromise?.()
    } else {
      lastLog = text
    }
  }

  proc.stdout.on("data", handleStdData)
  proc.stdout.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    if (!ready) {
      rejectPromise?.(error)
    }
  })
  proc.stderr.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, lastLog || `Container closed with code ${code}`)
    if (!ready) {
      rejectPromise?.(new Error(`Container closed with code ${code}`))
    }
    proc.kill()
  })

  await promise

  return proc
}

export async function startShkeeperStack({
  context,
  build,
  coreEnv,
  ethereumEnv,
  ethereumGithubRepo,
  ethereumGithubBranch,
}: {
  context: ServiceEnvBuildContext
  build: {
    imageName: string
    githubRepo?: string
    githubBranch?: string
  }
  coreEnv?: ShkeeperEnv
  ethereumEnv?: ShkeeperEthereumEnv
  /** When set, build `etherna/ethereum-shkeeper:…` from this repo before starting adapter containers. */
  ethereumGithubRepo?: string
  /** Branch or tag to clone for `ethereumGithubRepo` (defaults to `main` in the builder). */
  ethereumGithubBranch?: string
}) {
  const networkName = "host"
  const started = [] as ReturnType<typeof spawn>[]

  try {
    await ensureShkeeperDockerImage(build.githubRepo, build.githubBranch)
    await ensureEthereumShkeeperDockerImage(ethereumGithubRepo, ethereumGithubBranch)

    const ethereumImageName = resolveEthereumShkeeperImageName(ethereumGithubRepo)

    const [mariadb, redis] = await Promise.all([
      startShkeeperMariaDbContainer(networkName),
      startShkeeperRedisContainer(networkName),
    ])
    started.push(mariadb, redis)

    const [ethereumApi, ethereumTasks] = await Promise.all([
      startShkeeperEthereumApiContainer({
        context,
        envs: ethereumEnv,
        networkName,
        imageName: ethereumImageName,
      }),
      startShkeeperEthereumTasksContainer({
        context,
        envs: ethereumEnv,
        networkName,
        imageName: ethereumImageName,
      }),
    ])
    started.push(ethereumApi, ethereumTasks)

    const shkeeper = await startShkeeperCoreContainer({
      context,
      envs: coreEnv,
      build,
      networkName,
    })
    started.push(shkeeper)

    return started
  } catch (error) {
    for (const proc of started) {
      proc.kill()
    }

    throw error
  }
}

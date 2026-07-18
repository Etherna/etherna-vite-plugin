import fs from "node:fs"
import chalk from "chalk"

import {
  BLOCKCHAIN_OWNER_ADDRESS,
  getEnv,
  POSTAGE_STAMP_ADMIN_PRIVATE_KEY,
  stripPluginInternalEnvKeys,
} from "../env"
import { getPortlessPublicUrl } from "../portless"
import {
  createContainerVolume,
  createNetwork,
  isContainerRunning,
  startDockerContainer,
  stopContainer,
} from "../runtime/docker"
import {
  getBeeUnderlayAddress,
  logError,
  logSuccess,
  resolvePath,
  resolvePathEscape,
} from "../utils"
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
} from "../web3"

import type { ServiceStartContext } from "./context"
import type { ChildProcess } from "node:child_process"

const BEE_NETWORK_NAME = "etherna_bee_network"

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

export async function startBlockchain(ctx: ServiceStartContext): Promise<ChildProcess | null> {
  const context = ctx.serviceCtx
  const envs = ctx.getServiceEnv("bee")
  const name = "etherna-blockchain"
  const volumeName = "etherna_blockchain-volume"
  const detached = ctx.detached

  const envEarly = stripPluginInternalEnvKeys({
    ...(getEnv(name, context) ?? {}),
    ...envs,
  })
  const blockchainPortEarly = Number(envEarly.BLOCKCHAIN_PORT)

  if (detached && (await isContainerRunning(name))) {
    logSuccess(name, "http", String(blockchainPortEarly))
    return null
  }

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
    detached,
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

  if (!proc) {
    settleBlockchainBootstrap()
    logSuccess(name, "http", String(blockchainPort))
    return null
  }
  ctx.pushSpawn(proc)

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

  proc.stdout?.on("data", handleStdData)
  proc.stdout?.on("error", (error) => {
    settleBlockchainBootstrap()
    logError(name, "FATAL: " + error.message)
    endPromise?.()
  })
  proc.stderr?.on("data", handleStdData)
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

export async function startBeeNodes(ctx: ServiceStartContext): Promise<(ChildProcess | null)[]> {
  const context = ctx.serviceCtx
  const envs = ctx.getServiceEnv("bee")
  const name = "etherna-bee"

  const queenProc = await startBeeNode(ctx, name)

  const bootnode = await getBeeUnderlayAddress(
    `http://localhost:${getEnv("etherna-bee", context)?.BEE_PORT ?? "1633"}`,
  )

  const [worker1Proc] = await Promise.all([
    startBeeNode(ctx, name, 1, bootnode),
    // startBeeNode(ctx, name, 2, bootnode),
    // startBeeNode(ctx, name, 3, bootnode),
    // startBeeNode(ctx, name, 4, bootnode),
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

async function startBeeNode(
  ctx: ServiceStartContext,
  name: string,
  worker?: 1 | 2 | 3 | 4,
  bootnode?: string,
): Promise<ChildProcess | null> {
  const context = ctx.serviceCtx
  const envs = ctx.getServiceEnv("bee")
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
    detached: ctx.detached,
  })

  if (!proc) {
    if (!worker) {
      const portlessUrl = context.portless ? getPortlessPublicUrl("bee") : undefined
      logSuccess(name, mode, String(env.BEE_PORT ?? "1633"), { portlessUrl })
    }
    return null
  }
  ctx.pushSpawn(proc)

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

  proc.stdout?.on("data", handleStdData)
  proc.stdout?.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    endPromise?.()
  })
  proc.stderr?.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, lastLog || `Container closed with code ${code}`)
    endPromise?.()
    proc.kill()
  })

  await promise

  return proc
}

export async function startInterceptor(
  ctx: ServiceStartContext,
  name: string,
): Promise<ChildProcess | null> {
  const context = ctx.serviceCtx
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
    detached: ctx.detached,
  })

  if (!proc) {
    endPromise?.()
    return null
  }
  ctx.pushSpawn(proc)

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

  proc.stdout?.on("data", handleStdData)
  proc.stdout?.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    endPromise?.()
  })
  proc.stderr?.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, lastLog || `Container closed with code ${code}`)
    endPromise?.()
    proc.kill()
  })

  await promise

  return proc
}

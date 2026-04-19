/**
 * Minimal Ethereum JSON-RPC + tx-signing helpers used by the plugin to talk to
 * the dev-chain geth container without pulling in a full web3/ethers/viem
 * dependency.
 *
 * All RPC helpers are stateless and take an `rpcUrl`. They throw on transport
 * or RPC-level errors so callers can decide how to surface them.
 *
 * The signing helpers implement just enough RLP + EIP-155 to sign and broadcast
 * a single legacy transaction. We sign client-side because geth 1.13+ removed
 * `personal_importRawKey` / `personal_unlockAccount` from the HTTP API, so we
 * cannot rely on geth-managed signing for any account other than the Clique
 * signer that geth itself keeps unlocked.
 *
 * The implementation intentionally does NOT support EIP-1559 / 2930 envelopes;
 * the Clique dev chain accepts legacy txs and that keeps the code small.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js"
import { keccak_256 } from "@noble/hashes/sha3.js"

const DEFAULT_TX_RECEIPT_POLL_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** Performs a JSON-RPC POST and unwraps `result`/`error` for the caller. */
export async function ethJsonRpc<T = unknown>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  if (!resp.ok) {
    throw new Error(`RPC ${method} failed: ${resp.status} ${resp.statusText}`)
  }
  const data = (await resp.json()) as {
    error?: { message?: string }
    result?: T
  }
  if (data.error?.message) {
    throw new Error(`RPC ${method} error: ${data.error.message}`)
  }
  return data.result as T
}

/** Resolves the 4-byte function selector for `signature` via geth's `web3_sha3`. */
export async function getFunctionSelector(rpcUrl: string, signature: string): Promise<string> {
  const hex = "0x" + Buffer.from(signature, "utf-8").toString("hex")
  const digest = await ethJsonRpc<string>(rpcUrl, "web3_sha3", [hex])
  return digest.slice(0, 10)
}

/** ABI-encodes a single uint up to 256 bits as a 32-byte big-endian word (no `0x` prefix). */
export function encodeUintParam(value: bigint): string {
  if (value < 0n) {
    throw new Error(`Cannot encode negative uint param: ${value}`)
  }
  return value.toString(16).padStart(64, "0")
}

/** ABI-encodes a 20-byte address as a 32-byte left-padded big-endian word (no `0x` prefix). */
export function encodeAddressParam(address: string): string {
  const trimmed = address.toLowerCase().startsWith("0x") ? address.slice(2) : address
  if (trimmed.length !== 40) {
    throw new Error(`Invalid address (expected 20 bytes / 40 hex chars): ${address}`)
  }
  return trimmed.toLowerCase().padStart(64, "0")
}

/** ABI-encodes a 32-byte hash as-is (no `0x` prefix). */
export function encodeBytes32Param(hash: string): string {
  const trimmed = hash.startsWith("0x") ? hash.slice(2) : hash
  if (trimmed.length !== 64) {
    throw new Error(`Invalid bytes32 (expected 32 bytes / 64 hex chars): ${hash}`)
  }
  return trimmed.toLowerCase()
}

/** Decodes a hex-encoded uint (with or without `0x` prefix) into a `bigint`. */
export function decodeUint(hex: string): bigint {
  const trimmed = hex.startsWith("0x") ? hex.slice(2) : hex
  if (trimmed.length === 0) {
    return 0n
  }
  return BigInt("0x" + trimmed)
}

/** Polls `eth_getTransactionReceipt` until `txHash` is mined or `timeoutMs` elapses. */
export async function waitForTxReceipt(
  rpcUrl: string,
  txHash: string,
  timeoutMs: number,
  pollMs: number = DEFAULT_TX_RECEIPT_POLL_MS,
): Promise<{ status: string; blockNumber?: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const receipt = await ethJsonRpc<{ status?: string; blockNumber?: string } | null>(
      rpcUrl,
      "eth_getTransactionReceipt",
      [txHash],
    )
    if (receipt?.status) {
      return { status: receipt.status, blockNumber: receipt.blockNumber }
    }
    await sleep(pollMs)
  }
  throw new Error(`Transaction ${txHash} was not mined within ${timeoutMs}ms`)
}

/** Returns the deployed bytecode at `address` as a hex string (`"0x"` if undeployed). */
export async function getEthereumCode(rpcUrl: string, address: string): Promise<string> {
  return await ethJsonRpc<string>(rpcUrl, "eth_getCode", [address, "latest"]).then(
    (result) => result ?? "0x",
  )
}

/** Returns the current chain head height as a number. */
export async function getEthereumBlockNumber(rpcUrl: string): Promise<number> {
  const result = await ethJsonRpc<string>(rpcUrl, "eth_blockNumber", [])
  return Number.parseInt(result ?? "0x0", 16)
}

/** True when `code` is non-empty bytecode (i.e. a contract is deployed at the address). */
export function isEthereumCodeDeployed(code: string): boolean {
  return code !== "0x" && code.length > 2
}

/** Returns the pending transaction count (next nonce) for `address`. */
export async function getEthereumTransactionCount(
  rpcUrl: string,
  address: string,
  block: "latest" | "pending" = "pending",
): Promise<bigint> {
  const result = await ethJsonRpc<string>(rpcUrl, "eth_getTransactionCount", [address, block])
  return decodeUint(result)
}

/** Returns the suggested gas price reported by the node. */
export async function getEthereumGasPrice(rpcUrl: string): Promise<bigint> {
  const result = await ethJsonRpc<string>(rpcUrl, "eth_gasPrice", [])
  return decodeUint(result)
}

// ----------------------------------------------------------------------------
// Hex / bytes utilities
// ----------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.startsWith("0x") ? hex.slice(2) : hex
  const padded = trimmed.length % 2 === 0 ? trimmed : "0" + trimmed
  return Uint8Array.from(Buffer.from(padded, "hex"))
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

/** Converts a non-negative bigint to its minimal big-endian byte representation (0n -> empty). */
function bigintToMinimalBytes(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error(`Cannot encode negative bigint: ${value}`)
  }
  if (value === 0n) {
    return new Uint8Array(0)
  }
  let hex = value.toString(16)
  if (hex.length % 2 !== 0) {
    hex = "0" + hex
  }
  return hexToBytes(hex)
}

// ----------------------------------------------------------------------------
// Minimal RLP encoder
// ----------------------------------------------------------------------------

type RlpInput = Uint8Array | RlpInput[]

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function rlpEncodeLength(length: number, offset: number): Uint8Array {
  if (length < 56) {
    return Uint8Array.of(offset + length)
  }
  const lenBytes = bigintToMinimalBytes(BigInt(length))
  return concat(Uint8Array.of(offset + 55 + lenBytes.length), lenBytes)
}

function rlpEncode(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0]! < 0x80) {
      return input
    }
    return concat(rlpEncodeLength(input.length, 0x80), input)
  }
  const encoded = input.map(rlpEncode)
  const payload = concat(...encoded)
  return concat(rlpEncodeLength(payload.length, 0xc0), payload)
}

// ----------------------------------------------------------------------------
// Keccak256 / address derivation / EIP-155 signing
// ----------------------------------------------------------------------------

/** Keccak-256 (NOT SHA3-256) hash of `data`. */
export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data)
}

/** Derives the 20-byte Ethereum address from a hex private key (with or without `0x`). */
export function privateKeyToAddress(privateKey: string): string {
  const pkBytes = hexToBytes(privateKey)
  if (pkBytes.length !== 32) {
    throw new Error(`Invalid private key length: expected 32 bytes, got ${pkBytes.length}`)
  }
  const pubUncompressed = secp256k1.getPublicKey(pkBytes, false)
  // Strip the leading 0x04 (uncompressed-format tag) before hashing.
  const hash = keccak_256(pubUncompressed.slice(1))
  return "0x" + bytesToHex(hash.slice(-20))
}

export interface LegacyTx {
  /** EIP-155 chain id. */
  chainId: bigint
  nonce: bigint
  gasPrice: bigint
  gasLimit: bigint
  /** 20-byte hex (`0x…`). */
  to: string
  value: bigint
  /** Hex calldata (`0x…`), may be `"0x"` for plain transfers. */
  data: string
}

/**
 * Signs `tx` as an EIP-155 legacy transaction with `privateKey` and returns the
 * raw RLP payload ready for `eth_sendRawTransaction` plus its tx hash.
 *
 * IMPORTANT: we pass `prehash: false` because the input we feed to ECDSA is
 * already keccak256'd (per yellow paper / EIP-155). Without it, noble's
 * default `prehash: true` would re-hash with sha256 and yield a non-Ethereum
 * signature.
 */
export function signLegacyTransaction(
  tx: LegacyTx,
  privateKey: string,
): { rawTx: string; hash: string } {
  if (!tx.to.startsWith("0x") || tx.to.length !== 42) {
    throw new Error(`Invalid 'to' address: ${tx.to}`)
  }

  const fields: Uint8Array[] = [
    bigintToMinimalBytes(tx.nonce),
    bigintToMinimalBytes(tx.gasPrice),
    bigintToMinimalBytes(tx.gasLimit),
    hexToBytes(tx.to),
    bigintToMinimalBytes(tx.value),
    hexToBytes(tx.data),
  ]

  const sigHashRlp = rlpEncode([
    ...fields,
    bigintToMinimalBytes(tx.chainId),
    new Uint8Array(0),
    new Uint8Array(0),
  ])
  const sigHash = keccak_256(sigHashRlp)

  const pkBytes = hexToBytes(privateKey)
  const sigBytes = secp256k1.sign(sigHash, pkBytes, {
    format: "recovered",
    lowS: true,
    prehash: false,
  })
  // `format: "recovered"` returns 65 bytes: recoveryId (1) ‖ r (32) ‖ s (32).
  const recoveryId = sigBytes[0]!
  const r = decodeUint(bytesToHex(sigBytes.subarray(1, 33)))
  const s = decodeUint(bytesToHex(sigBytes.subarray(33, 65)))
  const v = BigInt(recoveryId) + 35n + tx.chainId * 2n

  const signedRlp = rlpEncode([
    ...fields,
    bigintToMinimalBytes(v),
    bigintToMinimalBytes(r),
    bigintToMinimalBytes(s),
  ])

  return {
    rawTx: "0x" + bytesToHex(signedRlp),
    hash: "0x" + bytesToHex(keccak_256(signedRlp)),
  }
}

/**
 * Builds, signs (EIP-155 legacy), broadcasts and waits for a single tx from
 * `privateKey`. Fetches `chainId`, pending nonce and `gasPrice` from the node;
 * bumps a `0` gas-price to `1` wei because geth's gas-price oracle returns 0
 * on a freshly-booted dev chain.
 *
 * Throws if the receipt status is not `0x1` (use `onRevert` to customize the
 * error message).
 */
export async function sendSignedTransaction(
  rpcUrl: string,
  privateKey: string,
  call: { to: string; data: string; gasLimit: bigint; value?: bigint },
  options: {
    timeoutMs: number
    pollMs?: number
    onRevert?: (txHash: string) => string
  },
): Promise<string> {
  const from = privateKeyToAddress(privateKey)
  const [chainIdHex, nonce, gasPrice] = await Promise.all([
    ethJsonRpc<string>(rpcUrl, "eth_chainId", []),
    getEthereumTransactionCount(rpcUrl, from, "pending"),
    getEthereumGasPrice(rpcUrl),
  ])
  const chainId = decodeUint(chainIdHex)
  const { rawTx, hash } = signLegacyTransaction(
    {
      chainId,
      nonce,
      gasPrice: gasPrice === 0n ? 1n : gasPrice,
      gasLimit: call.gasLimit,
      to: call.to,
      value: call.value ?? 0n,
      data: call.data,
    },
    privateKey,
  )
  await ethJsonRpc<string>(rpcUrl, "eth_sendRawTransaction", [rawTx])
  const receipt = await waitForTxReceipt(rpcUrl, hash, options.timeoutMs, options.pollMs)
  if (receipt.status !== "0x1") {
    throw new Error(options.onRevert?.(hash) ?? `Transaction ${hash} reverted (status ${receipt.status}).`)
  }
  return hash
}

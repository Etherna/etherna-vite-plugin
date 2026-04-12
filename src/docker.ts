import { spawn } from "node:child_process"
import fs from "node:fs"
import chalk from "chalk"

import { CERTIFICATE_DIR, CONTAINER_CERTS_DIR } from "./consts"
import { type AspServiceEnv, type BeeEnv, type ElasticEnv, getEnv, type MongoEnv } from "./envs"
import { trustContainerCertificate } from "./ssl"
import {
  getBeeUnderlayAddress,
  logError,
  logLoading,
  logSuccess,
  resolvePath,
  resolvePathEscape,
} from "./utils"

const BEE_NETWORK_NAME = "etherna_bee_network"

const DOCKER_GET_STARTED_URL = "https://docs.docker.com/get-docker/"
const DOCKER_DAEMON_WAIT_MS = 120_000
const DOCKER_DAEMON_POLL_MS = 2_000

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

  const proc = spawn(
    "docker",
    ["run", "--rm", "--name", containerName, ...args, imageName, ...cmd],
    {},
  )
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

export async function startMongoDbContainer(envs?: MongoEnv) {
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

  const env = {
    ...(getEnv(name, "http") ?? {}),
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

export async function startElasticContainer(envs?: ElasticEnv) {
  const name = "elastic"
  const dataVolumeName = `etherna_${name}-data-volume`
  await createContainerVolume(dataVolumeName)

  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  const env = {
    ...(getEnv(name, "http") ?? {}),
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
  mode: "http" | "https",
  envs?: AspServiceEnv,
) {
  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  let lastLog: string | undefined = undefined

  const env = {
    ...(getEnv(name as "etherna-sso", mode) ?? {}),
    ...envs,
  }
  const port = env.ASPNETCORE_URLS.split(";")[0]?.split(":")[2] ?? "80"

  const proc = await startDockerContainer({
    containerName: name,
    imageName: image,
    args: [
      ...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`]),
      ...(mode === "https"
        ? ["-v", `${resolvePathEscape(CERTIFICATE_DIR)}:${CONTAINER_CERTS_DIR}/`]
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
      logSuccess(name, mode, port)
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

export async function startBlockchain(mode: "http" | "https", envs?: BeeEnv) {
  const name = "etherna-blockchain"
  const volumeName = "etherna_blockchain-volume"

  await createNetwork(BEE_NETWORK_NAME)
  await createContainerVolume(volumeName)

  let lastLog: string | undefined = undefined
  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  if (!fs.existsSync(resolvePath(".ethereum"))) {
    fs.mkdirSync(resolvePath(".ethereum"), { recursive: true, mode: 0o777 })
  }
  if (!fs.existsSync(resolvePath(".ethereum", "password"))) {
    fs.writeFileSync(resolvePath(".ethereum", "password"), "toTheSun", {
      encoding: "utf-8",
      mode: 0o644,
    })
  }

  const env = {
    ...(getEnv(name, mode) ?? {}),
    ...envs,
  }

  const blockchainPort = Number(env.BLOCKCHAIN_PORT)

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
      "-v",
      `${resolvePathEscape(".ethereum")}:/root/extra`,
    ],
    cmd: [
      "--allow-insecure-unlock",
      "--unlock=0xCEeE442a149784faa65C35e328CCd64d874F9a02",
      "--password=/root/extra/password",
      "--mine",
      "--miner.etherbase=0xCEeE442a149784faa65C35e328CCd64d874F9a02",
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
    if (/HTTP server started/gm.test(text)) {
      endPromise?.()
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

export async function startBeeNodes(mode: "http" | "https" = "http", envs?: BeeEnv) {
  const name = "etherna-bee"

  const queenProc = await startBeeNode(name, mode, undefined, undefined, envs)

  const bootnode = await getBeeUnderlayAddress(
    `http://localhost:${getEnv("etherna-bee", mode)?.BEE_PORT ?? "1633"}`,
  )

  const [worker1Proc] = await Promise.all([
    startBeeNode(name, mode, 1, bootnode, envs),
    // startBeeNode(name, mode, 2, bootnode, envs),
    // startBeeNode(name, mode, 3, bootnode, envs),
    // startBeeNode(name, mode, 4, bootnode, envs),
  ])
  return [queenProc, worker1Proc]
}

export async function startBeeNode(
  name: string,
  mode: "http" | "https" = "http",
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

  const env = {
    ...(getEnv(name, mode) ?? {}),
    ...envs,
  }

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
        logSuccess(name, mode, env.BEE_PORT ?? "1633")
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

export async function startInterceptor(name: string, _mode: "http" | "https") {
  let lastLog: string | undefined = undefined
  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  const env = getEnv(name, "http") ?? {}

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

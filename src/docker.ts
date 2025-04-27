import { spawn } from "node:child_process"
import fs from "node:fs"

import { CERTIFICATE_DIR, CONTAINER_CERTS_DIR } from "./consts"
import { getEnv } from "./envs"
import { trustContainerCertificate } from "./ssl"
import { logError, logLoading, logSuccess, resolvePath } from "./utils"

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

export async function startMongoDbContainer(name: string) {
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

  const env = getEnv(name, "http") ?? {}

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

export async function startAspContainer(name: string, image: string, mode: "http" | "https") {
  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  let lastLog: string | undefined = undefined

  const env = getEnv(name as "etherna-sso", mode)
  const port = env.ASPNETCORE_URLS.split(";")[0]?.split(":")[2] ?? "80"

  const proc = await startDockerContainer({
    containerName: name,
    imageName: image,
    args: [
      ...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`]),
      ...(mode === "https"
        ? ["-v", `${resolvePath(CERTIFICATE_DIR)}:${CONTAINER_CERTS_DIR}/`]
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
    ]
    if (/Exception:.+/gm.test(text) && !excludedErrorRegexes.some((regex) => regex.test(text))) {
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

export async function startBlockchain(name: string, mode: "http" | "https") {
  const volumeName = "etherna_blockchain-volume"
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

  const env = getEnv(name, mode) ?? {}

  const proc = await startDockerContainer({
    containerName: name,
    imageName: "fairdatasociety/fdp-play-blockchain:latest",
    args: [
      ...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`]),
      "--network",
      "host",
      "--mount",
      `type=volume,source=${volumeName},target=/root/.ethereum`,
      "-v",
      `${resolvePath(".ethereum")}:/root/extra`,
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
      "--http.port=9545",
      "--http.addr=0.0.0.0",
      "--http.vhosts=*",
      "--ws",
      '--ws.api="debug,web3,eth,txpool,net,personal"',
      "--ws.port=9546",
      "--ws.origins=*",
      "--maxpeers=0",
      "--networkid=4020",
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

export async function startBeeNodes(name: string, mode: "http" | "https" = "http") {
  const volumeName = "etherna_bee-volume"
  await createContainerVolume(volumeName)

  let lastLog: string | undefined = undefined
  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  const env = getEnv(name, mode) ?? {}

  const proc = await startDockerContainer({
    containerName: name,
    imageName: "fairdatasociety/fdp-play-queen:latest",
    args: [
      ...Object.entries(env).flatMap(([key, value]) => [`-e`, `${key}=${String(value)}`]),
      "--mount",
      `type=volume,source=${volumeName},target=/home/bee/.bee`,
      "--network",
      "host",
    ],
    cmd: ["start"],
  })
  const handleStdData = (data: unknown) => {
    lastLog = undefined

    const text = String(data)
    if (/"address"="\[\:\:\]\:\d+"/gm.test(text)) {
      logSuccess(name, mode, env.BEE_PORT ?? "1633")
      endPromise?.()
    }

    const excludedErrorRegexes = [/\"logger\"=\"node\/storageincentives\"/gm]
    if (/"level"="error"/gm.test(text) && !excludedErrorRegexes.some((regex) => regex.test(text))) {
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

import {
  ensureEthereumShkeeperDockerImage,
  ensureShkeeperDockerImage,
  resolveEthereumShkeeperImageName,
  resolveShkeeperImageName,
} from "../builder"
import { getEnv } from "../env"
import { createContainerVolume, startDockerContainer } from "../runtime/docker"
import { logError, logSuccess } from "../utils"

import type { ServiceStartContext } from "./context"
import type { ServiceEnvBuildContext, ShkeeperEnv, ShkeeperEthereumEnv } from "../env"
import type { ChildProcess } from "node:child_process"

const SHKEEPER_NETWORK_NAME = "etherna_shkeeper_network"

export async function startShkeeperCoreContainer({
  context,
  envs,
  build,
  networkName,
  detached = false,
}: {
  context: ServiceEnvBuildContext
  envs?: ShkeeperEnv
  build: {
    imageName: string
  }
  networkName: string
  detached?: boolean
}): Promise<ChildProcess | null> {
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
    detached,
  })

  if (!proc) {
    logSuccess(name, "http", port)
    endPromise?.()
    return null
  }

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

  proc.stdout?.on("data", handleStdData)
  proc.stdout?.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    if (!ready) {
      rejectPromise?.(error)
    }
  })
  proc.stderr?.on("data", handleStdData)
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
  detached = false,
}: {
  context: ServiceEnvBuildContext
  envs?: ShkeeperEthereumEnv
  networkName: string
  imageName: string
  detached?: boolean
}): Promise<ChildProcess | null> {
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
    detached,
  })

  if (!proc) {
    endPromise?.()
    return null
  }

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

  proc.stdout?.on("data", handleStdData)
  proc.stdout?.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    if (!ready) {
      rejectPromise?.(error)
    }
  })
  proc.stderr?.on("data", handleStdData)
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

export async function startShkeeperMariaDbContainer(
  networkName = SHKEEPER_NETWORK_NAME,
  opts?: { detached?: boolean },
): Promise<ChildProcess | null> {
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
    detached: Boolean(opts?.detached),
  })

  if (!proc) {
    endPromise?.()
    return null
  }

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

  proc.stdout?.on("data", handleStdData)
  proc.stdout?.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    if (!ready) {
      rejectPromise?.(error)
    }
  })
  proc.stderr?.on("data", handleStdData)
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

export async function startShkeeperRedisContainer(
  networkName = SHKEEPER_NETWORK_NAME,
  opts?: { detached?: boolean },
): Promise<ChildProcess | null> {
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
    detached: Boolean(opts?.detached),
  })

  if (!proc) {
    endPromise?.()
    return null
  }

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

  proc.stdout?.on("data", handleStdData)
  proc.stdout?.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    if (!ready) {
      rejectPromise?.(error)
    }
  })
  proc.stderr?.on("data", handleStdData)
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
  detached = false,
}: {
  context: ServiceEnvBuildContext
  envs?: ShkeeperEthereumEnv
  networkName: string
  imageName: string
  detached?: boolean
}): Promise<ChildProcess | null> {
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
    detached,
  })

  if (!proc) {
    endPromise?.()
    return null
  }

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

  proc.stdout?.on("data", handleStdData)
  proc.stdout?.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    if (!ready) {
      rejectPromise?.(error)
    }
  })
  proc.stderr?.on("data", handleStdData)
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

/**
 * Starts the full ShKeeper stack (mariadb + redis + ethereum adapter API/tasks + shkeeper core) on
 * the host network. Reads build source and env overrides from the shared {@link ServiceStartContext}.
 */
export async function startShkeeperStack(
  ctx: ServiceStartContext,
): Promise<(ChildProcess | null)[]> {
  const context = ctx.serviceCtx
  const detached = ctx.detached
  const config = ctx.getShkeeperConfig()
  const shkeeperBuild = ctx.getShkeeperBuild()
  const build = { imageName: resolveShkeeperImageName(shkeeperBuild.githubRepo) }
  const ethereumGithubRepo = config.ethereum?.githubRepo?.trim() || undefined
  const ethereumGithubBranch = config.ethereum?.githubBranch?.trim() || undefined

  const networkName = "host"
  const started: (ChildProcess | null)[] = []

  try {
    await ensureShkeeperDockerImage(shkeeperBuild.githubRepo, shkeeperBuild.githubBranch)
    await ensureEthereumShkeeperDockerImage(ethereumGithubRepo, ethereumGithubBranch)

    const ethereumImageName = resolveEthereumShkeeperImageName(ethereumGithubRepo)

    const [mariadb, redis] = await Promise.all([
      startShkeeperMariaDbContainer(networkName, { detached }),
      startShkeeperRedisContainer(networkName, { detached }),
    ])
    started.push(mariadb, redis)

    const [ethereumApi, ethereumTasks] = await Promise.all([
      startShkeeperEthereumApiContainer({
        context,
        envs: config.ethereum?.env,
        networkName,
        imageName: ethereumImageName,
        detached,
      }),
      startShkeeperEthereumTasksContainer({
        context,
        envs: config.ethereum?.env,
        networkName,
        imageName: ethereumImageName,
        detached,
      }),
    ])
    started.push(ethereumApi, ethereumTasks)

    const shkeeper = await startShkeeperCoreContainer({
      context,
      envs: config.env,
      build,
      networkName,
      detached,
    })
    started.push(shkeeper)

    ctx.pushSpawn(...started)

    return started
  } catch (error) {
    for (const proc of started) {
      proc?.kill()
    }

    throw error
  }
}

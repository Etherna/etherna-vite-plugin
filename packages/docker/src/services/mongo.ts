import { getEnv } from "../env"
import { createContainerVolume, startDockerContainer } from "../runtime/docker"
import { logError, logSuccess } from "../utils"

import type { ServiceStartContext } from "./context"
import type { ChildProcess } from "node:child_process"

/** Starts the MongoDB container and resolves once it reports startup complete (unless reused while detached). */
export async function startMongo(ctx: ServiceStartContext): Promise<ChildProcess | null> {
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
    ...(getEnv(name, ctx.serviceCtx) ?? {}),
    ...ctx.getServiceEnv("mongo"),
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
    detached: ctx.detached,
  })

  if (!proc) {
    logSuccess(name, "mongodb", "27017")
    return null
  }
  ctx.pushSpawn(proc)

  const handleStdData = (data: unknown) => {
    const text = String(data)
    if (/mongod startup complete/gm.test(text)) {
      logSuccess(name, "mongodb", "27017")
      endPromise?.()
    }
  }

  proc.stdout?.on("data", handleStdData)
  proc.stdout?.on("error", (error) => {
    logError(name, "FATAL: " + error.message)
    endPromise?.()
  })
  proc.stderr?.on("data", handleStdData)
  proc.on("close", (code) => {
    logError(name, `Container closed with code ${code}`)
    endPromise?.()
    proc.kill()
  })

  await promise

  return proc
}

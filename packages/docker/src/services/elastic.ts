import { getEnv } from "../env"
import { createContainerVolume, startDockerContainer } from "../runtime/docker"
import { logError, logSuccess } from "../utils"

import type { ServiceStartContext } from "./context"
import type { ChildProcess } from "node:child_process"

/** Starts the Elasticsearch container and resolves once it reports "started" (unless reused while detached). */
export async function startElastic(ctx: ServiceStartContext): Promise<ChildProcess | null> {
  const name = "elastic"
  const dataVolumeName = `etherna_${name}-data-volume`
  await createContainerVolume(dataVolumeName)

  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  const env = {
    ...(getEnv(name, ctx.serviceCtx) ?? {}),
    ...ctx.getServiceEnv("elastic"),
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
    detached: ctx.detached,
  })

  if (!proc) {
    logSuccess(name, "http", "9200")
    return null
  }
  ctx.pushSpawn(proc)

  const handleStdData = (data: unknown) => {
    const text = String(data)
    if (/"message": "started"/gm.test(text)) {
      logSuccess(name, "http", "9200")
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

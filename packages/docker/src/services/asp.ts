import { CERTIFICATE_DIR, CONTAINER_CERTS_DIR } from "../consts"
import { getEnv } from "../env"
import { getPortlessPublicUrl, PORTLESS_CONTAINER_ALIASES } from "../portless"
import { startDockerContainer } from "../runtime/docker"
import { trustContainerCertificate } from "../ssl-trust"
import { logError, logSuccess, resolvePathEscape } from "../utils"

import type { ServiceStartContext } from "./context"
import type { AspServiceEnv } from "../env"
import type { ChildProcess } from "node:child_process"

/**
 * Starts an ASP.NET Etherna service container (sso/index/gateway/credit/beehive). Resolves once the
 * app logs "Now listening on …" (unless reused while detached). `envs` are the caller's per-service
 * overrides (the manager passes `ctx.getServiceEnv(<key>)`).
 */
export async function startAspContainer(
  ctx: ServiceStartContext,
  name: string,
  image: string,
  envs?: AspServiceEnv,
): Promise<ChildProcess | null> {
  let endPromise = undefined as undefined | (() => void)
  const promise = new Promise<void>((res) => {
    endPromise = res
  })

  let lastLog: string | undefined = undefined

  const { mode } = ctx.serviceCtx
  const env = {
    ...(getEnv(name as "etherna-sso", ctx.serviceCtx) ?? {}),
    ...envs,
  }
  const port = env.ASPNETCORE_URLS.split(";")[0]?.split(":")[2] ?? "80"

  const alias = PORTLESS_CONTAINER_ALIASES[name]
  const portlessUrl = ctx.serviceCtx.portless && alias ? getPortlessPublicUrl(alias) : undefined

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
    detached: ctx.detached,
  })

  if (!proc) {
    logSuccess(name, mode, port, { portlessUrl })
    return null
  }
  ctx.pushSpawn(proc)

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

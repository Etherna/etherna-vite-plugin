import { spawn } from "node:child_process"
import fs from "node:fs"
import chalk from "chalk"

import { logError, logLoading } from "../utils"

import type { ChildProcess } from "node:child_process"

const ETHERNA_CONTAINER_PREFIX = "etherna-"

/** Prefixes `name` with `etherna-` unless it already carries the prefix. */
export function resolveEthernaContainerName(name: string): string {
  return name.startsWith(ETHERNA_CONTAINER_PREFIX) ? name : `${ETHERNA_CONTAINER_PREFIX}${name}`
}

const DOCKER_GET_STARTED_URL = "https://docs.docker.com/get-docker/"
const DOCKER_DAEMON_WAIT_MS = 30_000
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
  detached = false,
}: {
  containerName: string
  imageName: string
  args?: string[]
  cmd?: string[]
  /** When true, skip start if the container is already running; remove a non-running name conflict before `docker run`. */
  detached?: boolean
}): Promise<ChildProcess | null> {
  const dockerContainerName = resolveEthernaContainerName(containerName)

  if (!detached) {
    if (await isContainerNameInUse(dockerContainerName)) {
      await stopContainer(dockerContainerName)
    }
  } else {
    if (await isContainerRunning(dockerContainerName)) {
      return null
    }
    if (await isContainerNameInUse(dockerContainerName)) {
      await removeContainerForce(dockerContainerName)
    }
  }

  // When the plugin runs in detached mode, put `docker run` in its own session so terminal Ctrl+C
  // (SIGINT to the foreground process group) does not stop the CLI and tear down `--rm` containers.
  const runArgs = [
    "run",
    "--rm",
    "--name",
    dockerContainerName,
    ...args,
    imageName,
    ...cmd,
  ] as const
  const proc = (
    detached
      ? spawn("docker", [...runArgs], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn("docker", [...runArgs])
  ) as ChildProcess
  proc.stdout?.on("data", (data) => {
    const text = String(data)

    if (/Pulling from/gm.test(text)) {
      logLoading(dockerContainerName)
    }
    if (/Error response from daemon/gm.test(text)) {
      logError(dockerContainerName, text)
    }
  })
  if (detached) {
    proc.unref()
  }

  return proc
}

async function isContainerNameInUse(name: string) {
  const proc = spawn("docker", [
    "ps",
    "-a",
    "--filter",
    `name=${resolveEthernaContainerName(name)}`,
  ])
  const result = await new Promise<string>((res) => {
    let data = ""
    proc.stdout?.on("data", (d) => {
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

/** Stops the named container (`docker stop`), prefixing the name with `etherna-` when needed. */
export async function stopContainer(name: string) {
  const proc = spawn("docker", ["stop", resolveEthernaContainerName(name)])
  await new Promise<void>((res) => {
    proc.on("close", () => {
      res()
    })
  })
}

/** True when a container with this exact name exists and is running. */
export async function isContainerRunning(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", resolveEthernaContainerName(name)],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
    let out = ""
    proc.stdout?.on("data", (d) => {
      out += String(d)
    })
    proc.on("error", () => resolve(false))
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(false)
        return
      }
      resolve(out.trim().toLowerCase() === "true")
    })
  })
}

async function removeContainerForce(name: string) {
  await new Promise<void>((res) => {
    const proc = spawn("docker", ["rm", "-f", resolveEthernaContainerName(name)], {
      stdio: "ignore",
    })
    proc.on("error", () => res())
    proc.on("close", () => res())
  })
}

export async function createContainerVolume(volumeName: string) {
  const proc = spawn("docker", ["volume", "create", volumeName])

  await new Promise<void>((res) => {
    proc.on("close", () => {
      res()
    })
  })
}

export async function createNetwork(networkName: string) {
  const proc = spawn("docker", ["network", "create", networkName])

  await new Promise<void>((res) => {
    proc.on("close", () => {
      res()
    })
  })
}

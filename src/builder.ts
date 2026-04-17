import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import chalk from "chalk"

import { logError, resolvePath } from "./utils"

/** Upstream image when not building from a custom GitHub repo. */
export const DEFAULT_SHKEEPER_IMAGE = "vsyshost/shkeeper:2.5.12"
export const DEFAULT_ETHEREUM_SHKEEPER_IMAGE = "vsyshost/ethereum-shkeeper:1.2.3"

/** Default source repo for SHKeeper core when `githubRepo` is not set (still tagged as {@link DEFAULT_SHKEEPER_IMAGE}). */
export const DEFAULT_SHKEEPER_GITHUB_REPO = "vsys-host/shkeeper.io"

/** Branch or tag to clone when `githubRepo` points at a custom fork (default upstream clone still uses the pinned image tag). */
export const DEFAULT_GITHUB_BRANCH = "main"

const CUSTOM_IMAGE_REGISTRY_PREFIX = "etherna"

const GITHUB_REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/

export function assertValidGithubRepo(repo: string) {
  if (!GITHUB_REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid githubRepo "${repo}". Expected "owner/repo".`)
  }
}

export function parseImageRef(image: string): { repository: string; tag: string } {
  const idx = image.lastIndexOf(":")
  if (idx === -1 || image.slice(idx + 1).includes("/")) {
    return { repository: image, tag: "latest" }
  }
  return { repository: image.slice(0, idx), tag: image.slice(idx + 1) }
}

/** When `githubRepo` is set, the built image is tagged under `etherna/…` with the same tag as the default upstream image. */
export function resolveShkeeperImageName(githubRepo?: string): string {
  const { tag } = parseImageRef(DEFAULT_SHKEEPER_IMAGE)
  if (!githubRepo) {
    return DEFAULT_SHKEEPER_IMAGE
  }
  return `${CUSTOM_IMAGE_REGISTRY_PREFIX}/shkeeper:${tag}`
}

export function resolveEthereumShkeeperImageName(githubRepo?: string): string {
  const { tag } = parseImageRef(DEFAULT_ETHEREUM_SHKEEPER_IMAGE)
  if (!githubRepo) {
    return DEFAULT_ETHEREUM_SHKEEPER_IMAGE
  }
  return `${CUSTOM_IMAGE_REGISTRY_PREFIX}/ethereum-shkeeper:${tag}`
}

async function isDockerImageAvailable(imageName: string) {
  const proc = spawn("docker", ["image", "inspect", imageName])

  return await new Promise<boolean>((resolve) => {
    proc.on("close", (code) => {
      resolve(code === 0)
    })
    proc.on("error", () => {
      resolve(false)
    })
  })
}

async function runCommandStrict(command: string, args: string[]) {
  const proc = spawn(command, args)

  await new Promise<void>((resolve, reject) => {
    proc.on("close", (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`Command failed: ${command} ${args.join(" ")}`))
    })
    proc.on("error", reject)
  })
}

function makeTempWorkspace(prefix: string, ref: string) {
  const safeRef = ref.replace(/[^a-z0-9._-]+/gi, "-")
  return resolvePath(prefix, `${safeRef}-${Date.now()}`)
}

async function acquireGitCloneBuildContext(
  githubRepo: string,
  workspacePrefix: string,
  gitRef: string,
) {
  const workspaceRoot = makeTempWorkspace(workspacePrefix, gitRef)
  fs.mkdirSync(workspaceRoot, { recursive: true })
  const cloneRoot = path.join(workspaceRoot, "clone")
  await runCommandStrict("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    gitRef,
    `https://github.com/${githubRepo}.git`,
    cloneRoot,
  ])
  return {
    cleanupPath: workspaceRoot,
    contextPath: cloneRoot,
    dockerfilePath: path.join(cloneRoot, "Dockerfile"),
  }
}

/**
 * Ensures a local image exists by shallow-cloning `sourceRepo` at `gitRef` and running `docker build`.
 */
export async function ensureDockerImageFromGitHub(options: {
  logLabel: string
  imageName: string
  sourceRepo: string
  workspacePrefix: string
  /** Git branch or tag to clone. */
  gitRef: string
}) {
  const { logLabel, imageName, sourceRepo, workspacePrefix, gitRef } = options

  if (await isDockerImageAvailable(imageName)) {
    console.log(
      `  ${chalk.gray("➜")}  ${chalk.bold(logLabel)}:   ${chalk.gray(`Using existing image ${imageName}.`)}`,
    )
    return
  }

  console.log(
    `  ${chalk.yellow("➜")}  ${chalk.bold(logLabel)}:   ${chalk.yellow(
      `Building Docker image from GitHub (${sourceRepo}@${gitRef}) (first run may take a while)…`,
    )}`,
  )

  const buildContext = await acquireGitCloneBuildContext(sourceRepo, workspacePrefix, gitRef)

  const proc = spawn("docker", [
    "build",
    "-t",
    imageName,
    "-f",
    buildContext.dockerfilePath,
    buildContext.contextPath,
  ])

  try {
    await new Promise<void>((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === 0) {
          resolve()
          return
        }

        reject(new Error(`Failed to build local Docker image ${imageName}`))
      })
      proc.on("error", reject)
    })
  } catch (error) {
    logError(logLabel, `Failed to build Docker image (${imageName}).`)
    if (buildContext.cleanupPath) {
      throw new Error(
        `Failed to build local Docker image ${imageName}. Inspect cloned source at ${buildContext.contextPath}`,
        { cause: error },
      )
    }
    throw error
  }

  console.log(
    `  ${chalk.yellow("➜")}  ${chalk.bold(logLabel)}:   ${chalk.yellow("Finished building Docker image.")}`,
  )

  if (buildContext.cleanupPath) {
    fs.rmSync(buildContext.cleanupPath, { force: true, recursive: true })
  }
}

function resolveGitRefForCustomRepo(githubBranch?: string) {
  const trimmed = githubBranch?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_GITHUB_BRANCH
}

/** Builds SHKeeper core from GitHub when the image is missing; uses default upstream repo when `githubRepo` is unset. */
export async function ensureShkeeperDockerImage(
  githubRepo?: string,
  githubBranch?: string,
) {
  const imageName = resolveShkeeperImageName(githubRepo)
  const sourceRepo = githubRepo ?? DEFAULT_SHKEEPER_GITHUB_REPO
  const gitRef = githubRepo
    ? resolveGitRefForCustomRepo(githubBranch)
    : parseImageRef(DEFAULT_SHKEEPER_IMAGE).tag
  await ensureDockerImageFromGitHub({
    logLabel: "shkeeper",
    imageName,
    sourceRepo,
    workspacePrefix: ".shkeeper-build",
    gitRef,
  })
}

/** When `githubRepo` is set, builds the ethereum adapter from that repo; otherwise relies on pulling the upstream image. */
export async function ensureEthereumShkeeperDockerImage(
  githubRepo?: string,
  githubBranch?: string,
) {
  if (!githubRepo) {
    return
  }

  const imageName = resolveEthereumShkeeperImageName(githubRepo)
  const gitRef = resolveGitRefForCustomRepo(githubBranch)
  await ensureDockerImageFromGitHub({
    logLabel: "ethereum-shkeeper",
    imageName,
    sourceRepo: githubRepo,
    workspacePrefix: ".ethereum-shkeeper-build",
    gitRef,
  })
}

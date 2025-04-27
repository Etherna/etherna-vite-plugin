import fs from "node:fs"
import chalk from "chalk"

import { createCertificate } from "./certificate"
import {
  CERTIFICATE_CERT_NAME,
  CERTIFICATE_DIR,
  CERTIFICATE_KEY_NAME,
  CERTIFICATE_PFX_NAME,
} from "./consts"
import { resolvePath, runCommand } from "./utils"

export async function generateSslCertificate() {
  if (
    fs.existsSync(getCertificatePath("cert")) &&
    fs.existsSync(getCertificatePath("key")) &&
    fs.existsSync(getCertificatePath("pfx"))
  ) {
    const key = fs.readFileSync(getCertificatePath("key"))
    const cert = fs.readFileSync(getCertificatePath("cert"))
    const pfx = fs.readFileSync(getCertificatePath("pfx"))
    return {
      key,
      cert,
      pfx,
    }
  }

  if (!fs.existsSync(resolvePath(CERTIFICATE_DIR))) {
    fs.mkdirSync(resolvePath(CERTIFICATE_DIR))
  }

  const certs = createCertificate("etherna.localhost", ["host.docker.internal"])

  fs.writeFileSync(getCertificatePath("key"), certs.key)
  fs.writeFileSync(getCertificatePath("cert"), certs.cert)
  fs.writeFileSync(getCertificatePath("pfx"), Buffer.from(certs.pfx, "binary"))

  await trustCertificate()

  return certs
}

async function trustCertificate() {
  const trustProc = (() => {
    switch (process.platform) {
      case "darwin":
        return runCommand(
          "security",
          [
            "add-trusted-cert",
            "-p",
            "ssl",
            "-p",
            "basic",
            "-k",
            "~/Library/Keychains/login.keychain-db",
            getCertificatePath("cert"),
          ],
          {
            shell: true,
          },
        )
      case "linux":
        return runCommand("update-ca-certificates", [getCertificatePath("cert")], {
          shell: true,
        })
      case "win32":
        return runCommand("certutil", ["-addstore", "-f", "ROOT", getCertificatePath("cert")], {
          shell: true,
        })
      default:
        console.error(chalk.red("‼️ Unsupported platform for trusting certificate"))
        return null
    }
  })()

  if (!trustProc) {
    return
  }

  await trustProc.catch((err: unknown) => {
    console.error(chalk.red("‼️ Error trusting ssl certificate: " + (err as Error).message))
  })
}

export async function trustContainerCertificate(containerName: string) {
  await runCommand("docker", ["exec", containerName, "update-ca-certificates"]).catch(
    (err: unknown) => {
      console.error(
        chalk.red(
          `‼️ Error trusting certificate in container '${containerName}': ${(err as Error).message}`,
        ),
      )
    },
  )
}

export function getCertificatePath(type: "cert" | "key" | "pfx") {
  return resolvePath(
    CERTIFICATE_DIR,
    {
      cert: CERTIFICATE_CERT_NAME,
      key: CERTIFICATE_KEY_NAME,
      pfx: CERTIFICATE_PFX_NAME,
    }[type],
  )
}

import chalk from "chalk"

import { runCommand } from "./utils"

/**
 * Runs `update-ca-certificates` inside a running container so it trusts the
 * dev certificate we bind-mounted into it. Used by HTTPS ASP.NET services.
 */
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

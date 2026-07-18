import { stopContainer } from "./docker"

import type { EnabledServiceMap } from "../session"
import type { EthernaServiceName } from "../types"

/**
 * Docker container names that make up each logical service's group. Multi-container services
 * stop as a whole group (see design doc "Multi-container services"): `bee` includes the
 * blockchain container (matches today's `stopEnabledEthernaContainers` when `bee: true`), while
 * `blockchain` alone stops only the blockchain container.
 */
const CONTAINER_GROUPS: Record<EthernaServiceName, string[]> = {
  blockchain: ["etherna-blockchain"],
  bee: ["etherna-blockchain", "etherna-bee", "etherna-bee_worker_1"],
  beehive: ["etherna-beehive"],
  credit: ["etherna-credit"],
  elastic: ["etherna-elastic"],
  gateway: ["etherna-gateway"],
  index: ["etherna-index"],
  mongo: ["etherna-mongodb"],
  shkeeper: [
    "ethereum-shkeeper-mariadb",
    "ethereum-shkeeper-redis",
    "ethereum-shkeeper",
    "ethereum-tasks",
    "shkeeper",
  ],
  sso: ["etherna-sso"],
}

/** Returns the Docker container names belonging to a logical service's group. */
export function containerNamesFor(service: EthernaServiceName): string[] {
  return CONTAINER_GROUPS[service]
}

/** Stops the container groups for each named logical service (de-duplicated across overlapping groups). */
export async function stopLogicalServices(names: EthernaServiceName[]): Promise<void> {
  const containerNames = [...new Set(names.flatMap(containerNamesFor))]
  await Promise.all(containerNames.map((name) => stopContainer(name)))
}

/**
 * Stops the container groups for every service flagged `true` in `enabled`. Replaces the old
 * `stopEnabledEthernaContainers` (used after a startup failure with `onFailure: "stop"`).
 */
export async function stopEnabled(enabled: EnabledServiceMap): Promise<void> {
  const names = (Object.keys(enabled) as EthernaServiceName[]).filter((name) => enabled[name])
  await stopLogicalServices(names)
}

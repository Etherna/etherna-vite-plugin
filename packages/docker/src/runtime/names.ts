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

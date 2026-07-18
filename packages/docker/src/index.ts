export async function start(_options: Record<string, unknown> = {}) {
  return { shutdown: async () => {} }
}

export async function stop(_services: string | string[]) {}

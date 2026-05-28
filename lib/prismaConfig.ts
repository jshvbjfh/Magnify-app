import { Prisma } from '@prisma/client'

export const DEFAULT_POOLED_CONNECTION_LIMIT = 10

function parsePositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return parsed
}

export function normalizePrismaDatabaseUrl(
  databaseUrl: string,
  options?: { pooledConnectionLimit?: number },
) {
  const trimmedUrl = String(databaseUrl || '').trim()
  if (!trimmedUrl) return trimmedUrl

  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmedUrl)
  } catch {
    return trimmedUrl
  }

  const protocol = parsedUrl.protocol.toLowerCase()
  if (protocol !== 'postgresql:' && protocol !== 'postgres:') {
    return trimmedUrl
  }

  // For pgbouncer connections, respect connection_limit as specified in the URL.
  // Neon recommends connection_limit=1 because pgbouncer handles multiplexing;
  // bumping the limit causes Prisma to open more simultaneous connections than
  // Neon's pooler can satisfy, which triggers pool_timeout on cold starts.
  if (parsedUrl.searchParams.get('pgbouncer')?.toLowerCase() !== 'true') {
    return trimmedUrl
  }

  return trimmedUrl
}

export function buildPrismaClientOptions(
  env: NodeJS.ProcessEnv = process.env,
): Prisma.PrismaClientOptions {
  const databaseUrl = String(env.DATABASE_URL ?? '').trim()
  const normalizedDatabaseUrl = normalizePrismaDatabaseUrl(databaseUrl, {
    pooledConnectionLimit: parsePositiveInteger(
      env.PRISMA_POOLED_CONNECTION_LIMIT,
      DEFAULT_POOLED_CONNECTION_LIMIT,
    ),
  })

  if (!normalizedDatabaseUrl || normalizedDatabaseUrl === databaseUrl) {
    return {}
  }

  return {
    datasources: {
      db: {
        url: normalizedDatabaseUrl,
      },
    },
  }
}
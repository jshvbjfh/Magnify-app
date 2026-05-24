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

  if (parsedUrl.searchParams.get('pgbouncer')?.toLowerCase() !== 'true') {
    return trimmedUrl
  }

  const targetLimit = parsePositiveInteger(
    options?.pooledConnectionLimit,
    DEFAULT_POOLED_CONNECTION_LIMIT,
  )
  const currentLimit = Number(parsedUrl.searchParams.get('connection_limit') ?? '')

  if (!Number.isFinite(currentLimit) || currentLimit >= targetLimit) {
    return trimmedUrl
  }

  parsedUrl.searchParams.set('connection_limit', String(targetLimit))
  return parsedUrl.toString()
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
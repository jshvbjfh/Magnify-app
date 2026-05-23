import { describe, expect, it } from 'vitest'

import {
  buildPrismaClientOptions,
  DEFAULT_POOLED_CONNECTION_LIMIT,
  normalizePrismaDatabaseUrl,
} from '@/lib/prismaConfig'

describe('prisma pooled connection config', () => {
  it('raises pooled postgres urls above a single connection', () => {
    const url = 'postgresql://user:pass@example-pooler.neon.tech/app?sslmode=require&pgbouncer=true&connection_limit=1'

    const normalized = normalizePrismaDatabaseUrl(url)

    expect(normalized).toContain(`connection_limit=${DEFAULT_POOLED_CONNECTION_LIMIT}`)
  })

  it('keeps non-pooled urls unchanged', () => {
    const url = 'postgresql://user:pass@example.neon.tech/app?sslmode=require&connection_limit=1'

    expect(normalizePrismaDatabaseUrl(url)).toBe(url)
  })

  it('keeps pooled urls unchanged when they already allow enough connections', () => {
    const url = `postgresql://user:pass@example-pooler.neon.tech/app?sslmode=require&pgbouncer=true&connection_limit=${DEFAULT_POOLED_CONNECTION_LIMIT}`

    expect(normalizePrismaDatabaseUrl(url)).toBe(url)
  })

  it('builds a prisma datasource override only when the url changes', () => {
    const options = buildPrismaClientOptions({
      DATABASE_URL: 'postgresql://user:pass@example-pooler.neon.tech/app?sslmode=require&pgbouncer=true&connection_limit=1',
      PRISMA_POOLED_CONNECTION_LIMIT: '7',
    } as unknown as NodeJS.ProcessEnv)

    expect(options).toEqual({
      datasources: {
        db: {
          url: 'postgresql://user:pass@example-pooler.neon.tech/app?sslmode=require&pgbouncer=true&connection_limit=7',
        },
      },
    })
  })
})
import { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'

const DATABASE_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1017', 'P2024'])

export function isPrismaDatabaseUnavailableError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return DATABASE_UNAVAILABLE_CODES.has(error.code)
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return true
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase()
  return message.includes("can't reach database server")
    || message.includes('timed out fetching a new connection')
    || message.includes('server has closed the connection')
}

export function logDatabaseUnavailable(scope: string, error: unknown) {
  const code = error instanceof Prisma.PrismaClientKnownRequestError
    ? error.code
    : error instanceof Prisma.PrismaClientInitializationError
      ? 'PRISMA_INIT'
      : 'UNKNOWN'
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown database error')

  console.warn(`[${scope}] Database unavailable (${code}): ${message}`)
}

export function databaseUnavailableJson(options?: {
  body?: Record<string, unknown>
  message?: string
}) {
  return NextResponse.json(
    {
      code: 'DATABASE_UNAVAILABLE',
      error: options?.message || 'Database is temporarily unavailable. Reconnect and try again.',
      ...(options?.body || {}),
    },
    {
      status: 503,
      headers: { 'Retry-After': '30' },
    },
  )
}
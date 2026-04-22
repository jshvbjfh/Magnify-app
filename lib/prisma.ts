import { Prisma, PrismaClient } from '@prisma/client'

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined
  // eslint-disable-next-line no-var
  var prismaConnectionRetryAttached: boolean | undefined
}

const CONNECT_RETRY_DELAYS_MS = [400, 1200, 2400]
const DATABASE_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1017', 'P2024'])

function isTransientConnectionError(error: unknown) {
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

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function attachConnectionRetry(client: PrismaClient) {
  let connectPromise: Promise<void> | null = null

  async function connectWithRetry() {
    let lastError: unknown = null

    for (let attempt = 0; attempt <= CONNECT_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await client.$connect()
        return
      } catch (error) {
        lastError = error

        if (!isTransientConnectionError(error) || attempt === CONNECT_RETRY_DELAYS_MS.length) {
          throw error
        }

        const delayMs = CONNECT_RETRY_DELAYS_MS[attempt]
        console.warn(`[prisma] Database connect attempt ${attempt + 1} failed. Retrying in ${delayMs}ms.`)
        await wait(delayMs)
      }
    }

    throw lastError
  }

  function ensureConnected() {
    if (!connectPromise) {
      connectPromise = connectWithRetry().catch((error) => {
        connectPromise = null
        throw error
      })
    }

    return connectPromise
  }

  client.$use(async (params, next) => {
    await ensureConnected()

    try {
      return await next(params)
    } catch (error) {
      if (!isTransientConnectionError(error)) {
        throw error
      }

      connectPromise = null
      await ensureConnected()
      return next(params)
    }
  })

  void ensureConnected().catch(() => {
    // Allow the first real request to surface an error if the database stays unavailable.
  })
}

const prismaClient = global.prisma ?? new PrismaClient()

if (!global.prismaConnectionRetryAttached) {
  attachConnectionRetry(prismaClient)
  global.prismaConnectionRetryAttached = true
}

export const prisma = prismaClient

if (process.env.NODE_ENV !== 'production') global.prisma = prisma

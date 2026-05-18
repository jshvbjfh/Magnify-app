import type { Prisma, PrismaClient } from '@prisma/client'

import {
  APP_SCHEMA_STATE_KEY,
  APP_SCHEMA_VERSION,
  BOOTSTRAP_VERSION,
  SYNC_PROTOCOL_VERSION,
} from '@/lib/bootstrapConfig'

type PrismaDb = PrismaClient | Prisma.TransactionClient

export type BootstrapResult = {
  ok: boolean
  state: 'ready' | 'bootstrap_failed'
  schemaVersion: number
  syncProtocolVersion: number
  bootstrapVersion: number
  activePricingPlans: number
  seededPricingPlans: number
  backfilledRestaurants: number
  lastError: string | null
}

function resolveDatabaseKind() {
  const url = String(process.env.DATABASE_URL || '').trim().toLowerCase()
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgresql'
  return 'sqlite'
}

async function upsertSchemaState(db: PrismaDb, params: { lastError?: string | null }) {
  const now = new Date()

  return db.appSchemaState.upsert({
    where: { key: APP_SCHEMA_STATE_KEY },
    create: {
      key: APP_SCHEMA_STATE_KEY,
      databaseKind: resolveDatabaseKind(),
      schemaVersion: APP_SCHEMA_VERSION,
      lastMigratedAt: now,
      lastError: params.lastError ?? null,
    },
    update: {
      databaseKind: resolveDatabaseKind(),
      schemaVersion: APP_SCHEMA_VERSION,
      lastMigratedAt: now,
      lastError: params.lastError ?? null,
    },
  })
}

async function registerBranchDevice(db: PrismaDb, params: { deviceId?: string | null; appVersion?: string | null; restaurantId?: string | null }) {
  if (!params.deviceId || !params.restaurantId) return null

  return db.branchDevice.upsert({
    where: { deviceId: params.deviceId },
    create: {
      deviceId: params.deviceId,
      restaurantId: params.restaurantId,
      appVersion: String(params.appVersion || 'unknown'),
      schemaVersion: APP_SCHEMA_VERSION,
      lastSeenAt: new Date(),
      status: 'active',
    },
    update: {
      restaurantId: params.restaurantId,
      appVersion: String(params.appVersion || 'unknown'),
      schemaVersion: APP_SCHEMA_VERSION,
      lastSeenAt: new Date(),
      status: 'active',
    },
  })
}

export async function ensureAppBootstrap(
  db: PrismaDb,
  params: {
    migrationState?: string
    deviceId?: string | null
    appVersion?: string | null
    restaurantId?: string | null
  } = {},
): Promise<BootstrapResult> {
  try {
    const result = await (db as PrismaClient).$transaction(async (tx) => {
      await registerBranchDevice(tx, params)
      const state = await upsertSchemaState(tx, { lastError: null })

      return {
        ok: true,
        state: 'ready' as const,
        schemaVersion: state.schemaVersion,
        syncProtocolVersion: SYNC_PROTOCOL_VERSION,
        bootstrapVersion: BOOTSTRAP_VERSION,
        activePricingPlans: 0,
        seededPricingPlans: 0,
        backfilledRestaurants: 0,
        lastError: state.lastError,
      } satisfies BootstrapResult
    })

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Bootstrap failed'

    try {
      await upsertSchemaState(db, { lastError: message })
    } catch {
      // If schema bootstrap failed because the schema-state table itself is missing,
      // preserve the original failure and let the caller decide how to recover.
    }

    return {
      ok: false,
      state: 'bootstrap_failed',
      schemaVersion: APP_SCHEMA_VERSION,
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
      bootstrapVersion: BOOTSTRAP_VERSION,
      activePricingPlans: 0,
      seededPricingPlans: 0,
      backfilledRestaurants: 0,
      lastError: message,
    }
  }
}

export async function getPricingCatalog(db: PrismaDb) {
  const state = await db.appSchemaState.findUnique({ where: { key: APP_SCHEMA_STATE_KEY } })

  return {
    state: 'pricing_unavailable' as const,
    schemaVersion: state?.schemaVersion ?? APP_SCHEMA_VERSION,
    bootstrapVersion: BOOTSTRAP_VERSION,
    lastError: state?.lastError ?? null,
    plans: [] as Array<{ id: string; name: string; duration: number; price: number; currency: string }>,
  }
}

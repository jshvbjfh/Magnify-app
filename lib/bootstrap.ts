import type { Prisma, PrismaClient } from '@prisma/client'

import {
  APP_SCHEMA_STATE_KEY,
  APP_SCHEMA_VERSION,
  BOOTSTRAP_VERSION,
  DEFAULT_PRICING_PLANS,
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

async function upsertSchemaState(db: PrismaDb, params: { migrationState: string; lastError?: string | null }) {
  const now = new Date()

  return db.appSchemaState.upsert({
    where: { key: APP_SCHEMA_STATE_KEY },
    create: {
      key: APP_SCHEMA_STATE_KEY,
      databaseKind: resolveDatabaseKind(),
      schemaVersion: APP_SCHEMA_VERSION,
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
      bootstrapVersion: BOOTSTRAP_VERSION,
      migrationState: params.migrationState,
      lastMigratedAt: now,
      lastBootstrapAt: params.migrationState === 'ready' ? now : null,
      lastError: params.lastError ?? null,
    },
    update: {
      databaseKind: resolveDatabaseKind(),
      schemaVersion: APP_SCHEMA_VERSION,
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
      bootstrapVersion: BOOTSTRAP_VERSION,
      migrationState: params.migrationState,
      lastMigratedAt: now,
      ...(params.migrationState === 'ready' ? { lastBootstrapAt: now } : {}),
      lastError: params.lastError ?? null,
    },
  })
}

async function ensurePricingPlans(db: PrismaDb) {
  let seededPricingPlans = 0

  for (const plan of DEFAULT_PRICING_PLANS) {
    const existing = await db.pricingPlan.findUnique({
      where: { seedKey: plan.seedKey },
      select: { id: true },
    })

    if (!existing) {
      seededPricingPlans += 1
      await db.pricingPlan.create({
        data: {
          seedKey: plan.seedKey,
          systemManaged: true,
          isActive: true,
          name: plan.name,
          duration: plan.duration,
          price: plan.price,
          currency: plan.currency,
        },
      })
      continue
    }

    await db.pricingPlan.update({
      where: { seedKey: plan.seedKey },
      data: {
        name: plan.name,
        duration: plan.duration,
        currency: plan.currency,
        systemManaged: true,
      },
    })
  }

  return seededPricingPlans
}

async function backfillRestaurantScopedData(db: PrismaDb) {
  const owners = await db.user.findMany({
    where: { restaurantId: { not: null } },
    select: { id: true, restaurantId: true },
  })

  let backfilledRestaurants = 0

  for (const owner of owners) {
    if (!owner.restaurantId) continue

    const updates = await Promise.all([
      db.transaction.updateMany({
        where: { userId: owner.id, restaurantId: null },
        data: { restaurantId: owner.restaurantId },
      }),
      db.dailySummary.updateMany({
        where: { userId: owner.id, restaurantId: null },
        data: { restaurantId: owner.restaurantId },
      }),
      db.inventoryItem.updateMany({
        where: { userId: owner.id, restaurantId: null },
        data: { restaurantId: owner.restaurantId },
      }),
      db.dish.updateMany({
        where: { userId: owner.id, restaurantId: null },
        data: { restaurantId: owner.restaurantId },
      }),
      db.employee.updateMany({
        where: { userId: owner.id, restaurantId: null },
        data: { restaurantId: owner.restaurantId },
      }),
      db.dishSale.updateMany({
        where: { userId: owner.id, restaurantId: null },
        data: { restaurantId: owner.restaurantId },
      }),
      db.wasteLog.updateMany({
        where: { userId: owner.id, restaurantId: null },
        data: { restaurantId: owner.restaurantId },
      }),
      db.inventoryPurchase.updateMany({
        where: { userId: owner.id, restaurantId: null },
        data: { restaurantId: owner.restaurantId },
      }),
      db.shift.updateMany({
        where: { userId: owner.id, restaurantId: null },
        data: { restaurantId: owner.restaurantId },
      }),
    ])

    if (updates.some((result) => result.count > 0)) {
      backfilledRestaurants += 1
    }
  }

  return backfilledRestaurants
}

async function registerBranchDevice(db: PrismaDb, params: { deviceId?: string | null; appVersion?: string | null; restaurantId?: string | null }) {
  if (!params.deviceId) return null

  return db.branchDevice.upsert({
    where: { deviceId: params.deviceId },
    create: {
      deviceId: params.deviceId,
      restaurantId: params.restaurantId ?? null,
      appVersion: String(params.appVersion || 'unknown'),
      schemaVersion: APP_SCHEMA_VERSION,
      lastSeenAt: new Date(),
      status: 'active',
    },
    update: {
      restaurantId: params.restaurantId ?? undefined,
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
  const migrationState = params.migrationState || 'ready'

  try {
    const result = await (db as PrismaClient).$transaction(async (tx) => {
      const seededPricingPlans = await ensurePricingPlans(tx)
      const backfilledRestaurants = await backfillRestaurantScopedData(tx)
      await registerBranchDevice(tx, params)
      const activePricingPlans = await tx.pricingPlan.count({ where: { isActive: true } })
      const state = await upsertSchemaState(tx, {
        migrationState: activePricingPlans > 0 ? migrationState : 'bootstrap_failed',
        lastError: activePricingPlans > 0 ? null : 'Bootstrap completed without any active pricing plans',
      })

      return {
        ok: activePricingPlans > 0,
        state: activePricingPlans > 0 ? 'ready' : 'bootstrap_failed',
        schemaVersion: state.schemaVersion,
        syncProtocolVersion: state.syncProtocolVersion,
        bootstrapVersion: state.bootstrapVersion,
        activePricingPlans,
        seededPricingPlans,
        backfilledRestaurants,
        lastError: state.lastError,
      } satisfies BootstrapResult
    })

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Bootstrap failed'

    try {
      await upsertSchemaState(db, { migrationState: 'bootstrap_failed', lastError: message })
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
  const plans = await db.pricingPlan.findMany({
    where: { isActive: true },
    orderBy: { duration: 'asc' },
    select: { id: true, name: true, duration: true, price: true, currency: true },
  })

  const bootstrapComplete = Boolean(state && state.bootstrapVersion >= BOOTSTRAP_VERSION && state.migrationState === 'ready')

  return {
    state: plans.length > 0 ? 'ready' : bootstrapComplete ? 'pricing_unavailable' : 'bootstrap_failed',
    schemaVersion: state?.schemaVersion ?? APP_SCHEMA_VERSION,
    bootstrapVersion: state?.bootstrapVersion ?? 0,
    lastError: state?.lastError ?? null,
    plans,
  }
}
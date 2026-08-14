import type { Prisma, PrismaClient, SyncConflictLog, SyncCursor, SyncOutbox } from '@prisma/client'

import { randomUUID } from 'crypto'

import { logSyncActivity } from '@/lib/syncLogging'

type PrismaDb = PrismaClient | Prisma.TransactionClient

export const GLOBAL_SYNC_SCOPE_ID = 'global'
export const CLOUD_SYNC_TARGET = 'cloud'
export const SYNC_OUTBOX_BASE_RETRY_MS = 30_000
export const SYNC_OUTBOX_MAX_RETRY_MS = 15 * 60_000
export const SYNC_OUTBOX_MAX_ATTEMPTS = 8

// S3: Single authoritative source for sync entity type classification.
// All code that needs to know which entities are restaurant-wide vs branch-scoped
// must derive from these sets — never define a parallel list elsewhere.
export const RESTAURANT_WIDE_ENTITY_TYPES = new Set([
  'restaurant',
  'branch',
  'pricingPlan',
])

export const BRANCH_REQUIRED_ENTITY_TYPES = new Set([
  'dish',
  'inventoryItem',
  'staff',
  'restaurantTable',
  'restaurantOrder',
  'wasteLog',
  'inventoryPurchase',
  'inventoryBatchUsageLedger',
  'inventoryAdjustmentLog',
  'employeeShift',
  'dishSale',
  'dishIngredient',
  'mepListItem',
  'prepLog',
])

export type SyncOperation = 'upsert' | 'delete'

export type SyncChangeEnvelope = {
  mutationId: string
  scopeId: string
  restaurantId: string | null
  branchId: string | null
  entityType: string
  entityId: string
  operation: SyncOperation
  payload: unknown
  sourceDeviceId: string | null
  createdAt: string
}

export function getSyncOutboxRetryDelayMs(attemptCount: number) {
  const normalizedAttempts = Math.max(1, Number(attemptCount) || 1)
  return Math.min(
    SYNC_OUTBOX_MAX_RETRY_MS,
    SYNC_OUTBOX_BASE_RETRY_MS * (2 ** Math.min(normalizedAttempts - 1, 5)),
  )
}

export function isSyncOutboxRetryExhausted(attempts: number) {
  return (Number(attempts) || 0) >= SYNC_OUTBOX_MAX_ATTEMPTS
}

export function getSyncScopeId(restaurantId?: string | null) {
  return restaurantId ? restaurantId : GLOBAL_SYNC_SCOPE_ID
}

export function isRestaurantWideSyncEntity(entityType?: string | null) {
  return RESTAURANT_WIDE_ENTITY_TYPES.has(entityType as any)
}

export function getSyncDeviceId() {
  const value = String(process.env.MAGNIFY_DEVICE_ID || '').trim()
  return value || 'cloud'
}

export function serializeOutboxPayload(payload: unknown) {
  return JSON.stringify(payload ?? null)
}

export function deserializeOutboxPayload<T>(payload: string) {
  return JSON.parse(payload) as T
}

export async function enqueueSyncChange(
  db: PrismaDb,
  params: {
    restaurantId?: string | null
    branchId?: string | null
    entityType: string
    entityId: string
    operation: SyncOperation
    payload: unknown
    mutationId?: string
    sourceDeviceId?: string | null
  },
) {
  const scopeId = getSyncScopeId(params.restaurantId)

  return db.syncOutbox.create({
    data: {
      scopeId,
      restaurantId: params.restaurantId ?? null,
      branchId: params.branchId ?? null,
      entityType: params.entityType,
      entityId: params.entityId,
      operation: params.operation,
      payload: serializeOutboxPayload(params.payload),
      mutationId: params.mutationId || randomUUID(),
      sourceDeviceId: params.sourceDeviceId ?? getSyncDeviceId(),
      availableAt: new Date(),
    },
  })
}

// Entities every station must receive regardless of which station owns them.
// Under shared stock the pool is held by one station, so filtering these by the
// receiving station would leave every other station's device never hearing that
// the shared stock exists — it would keep showing its own stale numbers while
// happily continuing to trade.
const SHARED_STOCK_ENTITY_TYPES = ['inventoryItem', 'inventoryPurchase'] as const

export async function listPendingSyncOutboxChanges(
  db: PrismaDb,
  params: {
    scopeIds: string[]
    limit?: number
    branchId?: string | null
    sharedStock?: boolean
  },
) {
  return db.syncOutbox.findMany({
    where: {
      scopeId: { in: params.scopeIds },
      ...(params.branchId !== undefined
        ? {
            AND: [
              {
                OR: [
                  { scopeId: GLOBAL_SYNC_SCOPE_ID },
                  { entityType: 'restaurant' },
                  { entityType: 'branch' },
                  ...(params.sharedStock ? [{ entityType: { in: [...SHARED_STOCK_ENTITY_TYPES] } }] : []),
                  { branchId: params.branchId ?? null },
                ],
              },
            ],
          }
        : {}),
      syncedAt: null,
      attempts: { lt: SYNC_OUTBOX_MAX_ATTEMPTS },
      OR: [
        { availableAt: null },
        { availableAt: { lte: new Date() } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: params.limit ?? 200,
  })
}

export async function markSyncOutboxChangesSynced(db: PrismaDb, ids: string[]) {
  if (ids.length === 0) return { count: 0 }

  return db.syncOutbox.updateMany({
    where: { id: { in: ids } },
    data: {
      syncedAt: new Date(),
      claimedAt: null,
      lastError: null,
    },
  })
}

export async function markSyncOutboxChangesFailed(db: PrismaDb, rows: Array<{ id: string }>, message: string) {
  if (rows.length === 0) return

  // Fetch current attempt counts in a single query — was 2 queries per row (N+1 pattern)
  const existing = await db.syncOutbox.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    select: { id: true, attempts: true, scopeId: true, restaurantId: true, entityType: true, entityId: true, sourceDeviceId: true },
  })

  const exhaustedIds: string[] = []
  const retryUpdates: Array<{ id: string; availableAt: Date; attempts: number; lastError: string }> = []

  for (const row of existing) {
    const nextAttempts = row.attempts + 1
    const exhausted = isSyncOutboxRetryExhausted(nextAttempts)

    if (exhausted) {
      exhaustedIds.push(row.id)
    } else {
      retryUpdates.push({
        id: row.id,
        availableAt: new Date(Date.now() + getSyncOutboxRetryDelayMs(nextAttempts)),
        attempts: nextAttempts,
        lastError: message,
      })
    }

    logSyncActivity(exhausted ? 'warn' : 'info', exhausted ? 'sync.outbox.retry_exhausted' : 'sync.outbox.retry_scheduled', {
      scopeId: row.scopeId,
      restaurantId: row.restaurantId,
      entityType: row.entityType,
      entityId: row.entityId,
      sourceDeviceId: row.sourceDeviceId,
      attempts: nextAttempts,
      error: exhausted ? `Retry limit reached after ${nextAttempts} attempts: ${message}` : message,
    })
  }

  // Batch update exhausted rows (availableAt = null stops retries)
  if (exhaustedIds.length > 0) {
    await db.syncOutbox.updateMany({
      where: { id: { in: exhaustedIds } },
      data: {
        attempts: { increment: 1 },
        availableAt: null,
        lastError: `Retry limit reached: ${message}`,
        claimedAt: null,
      },
    })
  }

  // Update retry rows individually — each has a different availableAt backoff time
  // This is unavoidable per-row but is still O(unique rows) not O(2 * rows)
  for (const update of retryUpdates) {
    await db.syncOutbox.update({
      where: { id: update.id },
      data: {
        attempts: update.attempts,
        availableAt: update.availableAt,
        lastError: update.lastError,
        claimedAt: null,
      },
    })
  }
}

export async function resetSyncOutboxRowsForRetry(
  db: PrismaDb,
  params: {
    scopeIds: string[]
    entityType?: string
    entityId?: string
    onlyExhausted?: boolean
    branchId?: string | null
  },
) {
  return db.syncOutbox.updateMany({
    where: {
      scopeId: { in: params.scopeIds },
      ...(params.branchId !== undefined
        ? {
            OR: [
              { scopeId: GLOBAL_SYNC_SCOPE_ID },
              { entityType: 'restaurant' },
              { entityType: 'branch' },
              { branchId: params.branchId ?? null },
            ],
          }
        : {}),
      syncedAt: null,
      ...(params.entityType ? { entityType: params.entityType } : {}),
      ...(params.entityId ? { entityId: params.entityId } : {}),
      ...(params.onlyExhausted ? { attempts: { gte: SYNC_OUTBOX_MAX_ATTEMPTS } } : {}),
    },
    data: {
      attempts: 0,
      availableAt: new Date(),
      claimedAt: null,
      lastError: null,
    },
  })
}

export function mapSyncOutboxRows(rows: SyncOutbox[]): SyncChangeEnvelope[] {
  return rows.map((row) => ({
    mutationId: row.mutationId,
    scopeId: row.scopeId,
    restaurantId: row.restaurantId,
    branchId: row.branchId,
    entityType: row.entityType,
    entityId: row.entityId,
    operation: row.operation as SyncOperation,
    payload: deserializeOutboxPayload(row.payload),
    sourceDeviceId: row.sourceDeviceId,
    createdAt: row.createdAt.toISOString(),
  }))
}

export async function getSyncCursor(db: PrismaDb, params: { scopeId: string; restaurantId?: string | null; target?: string }) {
  const target = params.target || CLOUD_SYNC_TARGET
  return db.syncCursor.upsert({
    where: {
      scopeId_target: {
        scopeId: params.scopeId,
        target,
      },
    },
    create: {
      scopeId: params.scopeId,
      target,
      restaurantId: params.restaurantId ?? null,
    },
    update: {
      restaurantId: params.restaurantId ?? undefined,
    },
  })
}

export async function updateSyncCursor(
  db: PrismaDb,
  params: {
    scopeId: string
    restaurantId?: string | null
    target?: string
    lastPulledAt?: Date | null
    lastPushedAt?: Date | null
  },
) {
  const target = params.target || CLOUD_SYNC_TARGET
  return db.syncCursor.upsert({
    where: {
      scopeId_target: {
        scopeId: params.scopeId,
        target,
      },
    },
    create: {
      scopeId: params.scopeId,
      target,
      restaurantId: params.restaurantId ?? null,
      lastPulledAt: params.lastPulledAt ?? null,
      lastPushedAt: params.lastPushedAt ?? null,
    },
    update: {
      restaurantId: params.restaurantId ?? undefined,
      ...(params.lastPulledAt !== undefined ? { lastPulledAt: params.lastPulledAt } : {}),
      ...(params.lastPushedAt !== undefined ? { lastPushedAt: params.lastPushedAt } : {}),
    },
  })
}

export async function logSyncConflict(
  db: PrismaDb,
  params: {
    scopeId: string
    restaurantId?: string | null
    branchId?: string | null
    entityType: string
    entityId: string
    reason: string
    localMutationId?: string | null
    remoteMutationId?: string | null
    localPayload?: unknown
    remotePayload?: unknown
  },
): Promise<SyncConflictLog> {
  const conflict = await db.syncConflictLog.create({
    data: {
      scopeId: params.scopeId,
      restaurantId: params.restaurantId ?? null,
      branchId: params.branchId ?? null,
      entityType: params.entityType,
      entityId: params.entityId,
      reason: params.reason,
      localPayload: params.localPayload !== undefined ? serializeOutboxPayload(params.localPayload) : null,
      remotePayload: params.remotePayload !== undefined ? serializeOutboxPayload(params.remotePayload) : null,
    },
  })

  logSyncActivity('warn', 'sync.conflict.created', {
    conflictId: conflict.id,
    scopeId: params.scopeId,
    restaurantId: params.restaurantId ?? null,
    branchId: params.branchId ?? null,
    entityType: params.entityType,
    entityId: params.entityId,
    localMutationId: params.localMutationId ?? null,
    remoteMutationId: params.remoteMutationId ?? null,
    reason: params.reason,
  })

  return conflict
}

export function latestSyncChangeTimestamp(rows: SyncChangeEnvelope[]) {
  if (rows.length === 0) return null
  return rows.reduce((latest, row) => {
    const current = new Date(row.createdAt)
    return current > latest ? current : latest
  }, new Date(rows[0].createdAt))
}

export function latestSyncMutationId(rows: SyncChangeEnvelope[]) {
  return rows.length > 0 ? rows[rows.length - 1].mutationId : null
}
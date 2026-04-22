import type { Prisma, PrismaClient, SyncConflictLog, SyncCursor, SyncOutbox } from '@prisma/client'

import { randomUUID } from 'crypto'

import { logSyncActivity } from '@/lib/syncLogging'

type PrismaDb = PrismaClient | Prisma.TransactionClient

export const GLOBAL_SYNC_SCOPE_ID = 'global'
export const CLOUD_SYNC_TARGET = 'cloud'
export const SYNC_OUTBOX_BASE_RETRY_MS = 30_000
export const SYNC_OUTBOX_MAX_RETRY_MS = 15 * 60_000
export const SYNC_OUTBOX_MAX_ATTEMPTS = 8

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
  return entityType === 'restaurant' || entityType === 'restaurantBranch'
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

export async function listPendingSyncOutboxChanges(
  db: PrismaDb,
  params: {
    scopeIds: string[]
    limit?: number
    branchId?: string | null
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
                  { entityType: 'restaurantBranch' },
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
  for (const row of rows) {
    const existing = await db.syncOutbox.findUnique({
      where: { id: row.id },
      select: {
        id: true,
        attempts: true,
        scopeId: true,
        restaurantId: true,
        entityType: true,
        entityId: true,
        sourceDeviceId: true,
      },
    })

    if (!existing) continue

    const nextAttempts = existing.attempts + 1
    const exhausted = isSyncOutboxRetryExhausted(nextAttempts)
    const retryAt = exhausted ? null : new Date(Date.now() + getSyncOutboxRetryDelayMs(nextAttempts))
    const nextError = exhausted
      ? `Retry limit reached after ${nextAttempts} attempts: ${message}`
      : message

    await db.syncOutbox.update({
      where: { id: row.id },
      data: {
        attempts: nextAttempts,
        availableAt: retryAt,
        lastError: nextError,
        claimedAt: null,
      },
    })

    logSyncActivity(exhausted ? 'warn' : 'info', exhausted ? 'sync.outbox.retry_exhausted' : 'sync.outbox.retry_scheduled', {
      scopeId: existing.scopeId,
      restaurantId: existing.restaurantId,
      entityType: existing.entityType,
      entityId: existing.entityId,
      sourceDeviceId: existing.sourceDeviceId,
      attempts: nextAttempts,
      retryAt: retryAt?.toISOString() ?? null,
      error: nextError,
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
              { entityType: 'restaurantBranch' },
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
    lastMutationId?: string | null
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
      lastMutationId: params.lastMutationId ?? null,
    },
    update: {
      restaurantId: params.restaurantId ?? undefined,
      ...(params.lastPulledAt !== undefined ? { lastPulledAt: params.lastPulledAt } : {}),
      ...(params.lastPushedAt !== undefined ? { lastPushedAt: params.lastPushedAt } : {}),
      ...(params.lastMutationId !== undefined ? { lastMutationId: params.lastMutationId } : {}),
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
      localMutationId: params.localMutationId ?? null,
      remoteMutationId: params.remoteMutationId ?? null,
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
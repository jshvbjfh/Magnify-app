import type { SyncConflictLog } from '@prisma/client'

import { deserializeOutboxPayload, type SyncChangeEnvelope, type SyncOperation } from '@/lib/syncOutbox'

export type SyncConflictSide = {
  operation: SyncOperation
  payload: unknown
}

function parseSyncConflictSide(raw: string | null): SyncConflictSide | null {
  if (!raw) return null

  try {
    const parsed = deserializeOutboxPayload<any>(raw)
    if (parsed && typeof parsed === 'object' && ('operation' in parsed || 'payload' in parsed)) {
      return {
        operation: parsed.operation === 'delete' ? 'delete' : 'upsert',
        payload: parsed.payload,
      }
    }

    return {
      operation: 'upsert',
      payload: parsed,
    }
  } catch {
    return null
  }
}

export function mapSyncConflictRecord(conflict: SyncConflictLog) {
  return {
    id: conflict.id,
    scopeId: conflict.scopeId,
    restaurantId: conflict.restaurantId,
    branchId: conflict.branchId,
    entityType: conflict.entityType,
    entityId: conflict.entityId,
    reason: conflict.reason,
    localMutationId: conflict.localMutationId,
    remoteMutationId: conflict.remoteMutationId,
    localChange: parseSyncConflictSide(conflict.localPayload),
    remoteChange: parseSyncConflictSide(conflict.remotePayload),
    createdAt: conflict.createdAt.toISOString(),
  }
}

export function buildSyncChangeFromConflict(conflict: SyncConflictLog, side: 'local' | 'remote'): SyncChangeEnvelope | null {
  const parsed = parseSyncConflictSide(side === 'local' ? conflict.localPayload : conflict.remotePayload)
  if (!parsed) return null

  return {
    mutationId: side === 'local'
      ? conflict.localMutationId || `conflict-local-${conflict.id}`
      : conflict.remoteMutationId || `conflict-remote-${conflict.id}`,
    scopeId: conflict.scopeId,
    restaurantId: conflict.restaurantId,
    branchId: conflict.branchId,
    entityType: conflict.entityType,
    entityId: conflict.entityId,
    operation: parsed.operation,
    payload: parsed.payload,
    sourceDeviceId: null,
    createdAt: new Date().toISOString(),
  }
}
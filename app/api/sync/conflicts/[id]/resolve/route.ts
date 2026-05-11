import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { buildSyncChangeFromConflict } from '@/lib/syncConflict'
import { applyResolvedSyncChange } from '@/lib/syncEngine'
import { logSyncActivity } from '@/lib/syncLogging'
import { GLOBAL_SYNC_SCOPE_ID, resetSyncOutboxRowsForRetry } from '@/lib/syncOutbox'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = session.user as any
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId) {
    return NextResponse.json({ error: 'No restaurant linked' }, { status: 404 })
  }

  const body = await req.json().catch(() => null)
  const resolution = body?.resolution === 'accept_remote' ? 'accept_remote' : body?.resolution === 'accept_local' ? 'accept_local' : null

  if (!resolution) {
    return NextResponse.json({ error: 'resolution must be accept_local or accept_remote' }, { status: 400 })
  }

  const branchFilter = context.branchId ? { branchId: context.branchId } : { branchId: null }
  const conflict = await prisma.syncConflictLog.findFirst({
    where: {
      id: params.id,
      OR: [
        { scopeId: GLOBAL_SYNC_SCOPE_ID },
        { restaurantId: context.restaurantId, ...branchFilter },
      ],
    },
  })

  if (!conflict) {
    return NextResponse.json({ error: 'Conflict not found' }, { status: 404 })
  }

  const remoteChange = buildSyncChangeFromConflict(conflict, 'remote')

  await prisma.$transaction(async (tx) => {
    if (resolution === 'accept_remote') {
      await tx.syncOutbox.updateMany({
        where: {
          scopeId: conflict.scopeId,
          entityType: conflict.entityType,
          entityId: conflict.entityId,
          syncedAt: null,
        },
        data: {
          syncedAt: new Date(),
          claimedAt: null,
          lastError: 'Superseded by accepted remote conflict resolution',
        },
      })

      if (!remoteChange) {
        throw new Error('Remote conflict payload is unavailable')
      }

      await applyResolvedSyncChange(tx, remoteChange)
    } else {
      await resetSyncOutboxRowsForRetry(tx, {
        scopeIds: [conflict.scopeId],
        entityType: conflict.entityType,
        entityId: conflict.entityId,
      })
    }

    await tx.syncConflictLog.delete({ where: { id: conflict.id } })
  })

  logSyncActivity('info', 'sync.conflict.resolved', {
    conflictId: conflict.id,
    restaurantId: context.restaurantId,
    scopeId: conflict.scopeId,
    entityType: conflict.entityType,
    entityId: conflict.entityId,
    resolution,
    resolvedBy: session.user.id,
  })

  return NextResponse.json({ ok: true })
}
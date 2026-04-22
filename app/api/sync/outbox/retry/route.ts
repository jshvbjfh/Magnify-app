import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ensureRestaurantForOwner } from '@/lib/restaurantAccess'
import { logSyncActivity } from '@/lib/syncLogging'
import { GLOBAL_SYNC_SCOPE_ID, resetSyncOutboxRowsForRetry } from '@/lib/syncOutbox'

export async function POST() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = session.user as any
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const restaurant = await ensureRestaurantForOwner(session.user.id)
  const result = await resetSyncOutboxRowsForRetry(prisma, {
    scopeIds: [restaurant.id, GLOBAL_SYNC_SCOPE_ID],
    onlyExhausted: true,
  })

  logSyncActivity('info', 'sync.outbox.requeued', {
    restaurantId: restaurant.id,
    resetCount: result.count,
    requestedBy: session.user.id,
  })

  return NextResponse.json({ ok: true, resetCount: result.count })
}
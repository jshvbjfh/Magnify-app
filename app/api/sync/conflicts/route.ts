import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ensureRestaurantForOwner } from '@/lib/restaurantAccess'
import { mapSyncConflictRecord } from '@/lib/syncConflict'
import { GLOBAL_SYNC_SCOPE_ID } from '@/lib/syncOutbox'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = session.user as any
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  let restaurant: Awaited<ReturnType<typeof ensureRestaurantForOwner>>
  try {
    restaurant = await ensureRestaurantForOwner(session.user.id)
  } catch (e: any) {
    if (e?.code === 'USER_NOT_FOUND') return NextResponse.json({ conflicts: [] }, { status: 200 })
    throw e
  }
  if (!restaurant) return NextResponse.json({ conflicts: [] }, { status: 200 })
  const conflicts = await prisma.syncConflictLog.findMany({
    where: {
      OR: [
        { restaurantId: restaurant.id },
        { scopeId: GLOBAL_SYNC_SCOPE_ID },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return NextResponse.json({
    conflicts: conflicts.map(mapSyncConflictRecord),
  })
}
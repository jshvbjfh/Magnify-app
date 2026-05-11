import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { mapSyncConflictRecord } from '@/lib/syncConflict'
import { GLOBAL_SYNC_SCOPE_ID } from '@/lib/syncOutbox'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = session.user as any
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId) return NextResponse.json({ conflicts: [] }, { status: 200 })

  const branchFilter = context.branchId ? { branchId: context.branchId } : { branchId: null }
  const conflicts = await prisma.syncConflictLog.findMany({
    where: {
      OR: [
        { scopeId: GLOBAL_SYNC_SCOPE_ID },
        { restaurantId: context.restaurantId, ...branchFilter },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return NextResponse.json({
    conflicts: conflicts.map(mapSyncConflictRecord),
  })
}
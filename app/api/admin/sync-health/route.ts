import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { SYNC_OUTBOX_MAX_ATTEMPTS } from '@/lib/syncOutbox'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [stalledRows, abandonedRows, recentFailures] = await Promise.all([
    // Rows in-flight but failed at least once, not yet synced, not yet exhausted
    prisma.syncOutbox.findMany({
      where: {
        syncedAt: null,
        attempts: { gt: 0, lt: SYNC_OUTBOX_MAX_ATTEMPTS },
        lastError: { not: null },
      },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        operation: true,
        attempts: true,
        lastError: true,
        restaurantId: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    }),
    // Rows that exhausted all retries — permanently abandoned
    prisma.syncOutbox.findMany({
      where: {
        syncedAt: null,
        attempts: { gte: SYNC_OUTBOX_MAX_ATTEMPTS },
      },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        operation: true,
        attempts: true,
        lastError: true,
        restaurantId: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    }),
    Promise.resolve([] as { id: string; restaurantId: string | null; message: string; createdAt: Date }[]),
  ])

  return NextResponse.json({ stalledRows, abandonedRows, recentFailures })
}

// PATCH /api/admin/sync-health — force-retry a stalled or abandoned outbox row
export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { outboxId } = await req.json()
  if (!outboxId || typeof outboxId !== 'string') {
    return NextResponse.json({ error: 'outboxId required' }, { status: 400 })
  }

  const updated = await prisma.syncOutbox.update({
    where: { id: outboxId },
    data: {
      attempts: 0,
      availableAt: new Date(),
      lastError: null,
    },
    select: { id: true, attempts: true },
  })

  return NextResponse.json({ ok: true, row: updated })
}

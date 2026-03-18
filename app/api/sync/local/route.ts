import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { buildSyncTransactions, mapSummaryPayload, normalizeTargetUrl, refreshDailySummaries } from '@/lib/minimalSync'
import { ensureRestaurantForOwner } from '@/lib/restaurantAccess'

async function requireAdminUser() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) throw new Error('Unauthorized')
  const user = session.user as any
  if (user.role !== 'admin') throw new Error('Admin only')
  return session.user.id
}

async function hasInternet(targetUrl: string) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(normalizeTargetUrl(targetUrl), { method: 'HEAD', signal: controller.signal, cache: 'no-store' })
    clearTimeout(timeout)
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

export async function POST(req: Request) {
  try {
    const userId = await requireAdminUser()
    const restaurant = await ensureRestaurantForOwner(userId)
    const body = await req.json()
    const targetUrl = String(body.targetUrl ?? process.env.OWNER_SYNC_TARGET_URL ?? '').trim()
    const email = String(body.email ?? process.env.OWNER_SYNC_EMAIL ?? '').trim().toLowerCase()
    const password = String(body.password ?? process.env.OWNER_SYNC_PASSWORD ?? '')
    const sharedSecret = String(process.env.OWNER_SYNC_SHARED_SECRET ?? '').trim()

    if (!targetUrl || !email || (!password && !sharedSecret)) {
      return NextResponse.json({ error: 'Sync target, sync email, and server-managed secret or password are required' }, { status: 400 })
    }

    const online = await hasInternet(targetUrl)
    if (!online) {
      console.log('[sync] Sync failed: internet or cloud target unavailable')
      return NextResponse.json({ ok: false, message: 'Sync failed' }, { status: 503 })
    }

    const unsyncedTransactions = await prisma.transaction.findMany({
      where: { userId, synced: false },
      include: { category: { select: { type: true } } },
      orderBy: { createdAt: 'asc' },
    })

    const affectedDates = unsyncedTransactions.map((row) => row.date).map((date) => {
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    })

    await refreshDailySummaries(prisma, userId, affectedDates, restaurant.id)

    const unsyncedSummaries = await prisma.dailySummary.findMany({
      where: { userId, restaurantId: restaurant.id, synced: false },
      orderBy: { date: 'asc' },
    })

    const { transactions, syncedIds } = buildSyncTransactions(unsyncedTransactions)
    const summaries = mapSummaryPayload(unsyncedSummaries)

    if (transactions.length === 0 && summaries.length === 0) {
      console.log('[sync] No data to sync')
      return NextResponse.json({ ok: true, message: 'No data to sync' })
    }

    const res = await fetch(`${normalizeTargetUrl(targetUrl)}/api/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-email': email,
        ...(sharedSecret ? { 'x-sync-secret': sharedSecret } : { 'x-sync-password': password }),
      },
      body: JSON.stringify({
        restaurantSyncId: restaurant.syncRestaurantId,
        restaurantName: restaurant.name,
        restaurantToken: restaurant.syncToken,
        transactions,
        summaries,
      }),
    })

    if (!res.ok) {
      const payload = await res.json().catch(() => null)
      console.log('[sync] Sync failed')
      return NextResponse.json({ ok: false, message: payload?.error || 'Sync failed' }, { status: res.status })
    }

    if (syncedIds.length > 0) {
      await prisma.transaction.updateMany({
        where: { id: { in: syncedIds } },
        data: { synced: true },
      })
    }

    if (unsyncedSummaries.length > 0) {
      await prisma.dailySummary.updateMany({
        where: { id: { in: unsyncedSummaries.map((row) => row.id) } },
        data: { synced: true },
      })
    }

    console.log('[sync] Sync success')
    return NextResponse.json({
      ok: true,
      message: 'Sync success',
      syncedTransactions: transactions.length,
      syncedSummaries: summaries.length,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed'
    const status = message === 'Unauthorized' ? 401 : message === 'Admin only' ? 403 : 500
    console.log('[sync] Sync failed')
    return NextResponse.json({ error: message }, { status })
  }
}
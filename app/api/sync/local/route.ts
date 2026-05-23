import { NextResponse, type NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveCloudRestaurantIdentity } from '@/lib/cloudRestaurantAccountProvision'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { getCanonicalCloudAppUrl } from '@/lib/cloudAuthBridge'
import {
  getSyncDeviceId,
  GLOBAL_SYNC_SCOPE_ID,
  listPendingSyncOutboxChanges,
  mapSyncOutboxRows,
  markSyncOutboxChangesSynced,
  markSyncOutboxChangesFailed,
  type SyncChangeEnvelope,
} from '@/lib/syncOutbox'
import { buildHybridSyncBatchSignature, normalizeTargetUrl } from '@/lib/minimalSync'
import { applyIncomingSyncChanges } from '@/lib/syncEngine'

export const dynamic = 'force-dynamic'

const SYNC_PUSH_TIMEOUT_MS = 30_000
const SYNC_MAX_CHANGES_PER_BATCH = 200

export async function GET() {
  return NextResponse.json({ error: 'Use POST to trigger a sync.' }, { status: 405 })
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const user = session.user as any
  if (!['admin', 'owner', 'waiter', 'kitchen'].includes(String(user.role))) {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
  }

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* no-op: body is optional */ }

  // Resolve sync credentials — server-managed env vars take precedence over client-provided
  const targetUrl = normalizeTargetUrl(
    String(process.env.OWNER_SYNC_TARGET_URL ?? body.targetUrl ?? getCanonicalCloudAppUrl() ?? '').trim(),
  )
  const sessionEmail = typeof session.user.email === 'string' ? session.user.email.trim().toLowerCase() : ''
  const requestEmail = String(body.email ?? sessionEmail).trim().toLowerCase()
  const requestPassword = String(body.password ?? '').trim()
  const email = String(process.env.OWNER_SYNC_EMAIL ?? body.email ?? sessionEmail).trim().toLowerCase()
  const sharedSecret = String(process.env.OWNER_SYNC_SHARED_SECRET ?? '').trim()
  const password = sharedSecret ? '' : String(process.env.OWNER_SYNC_PASSWORD ?? body.password ?? '').trim()

  if (!targetUrl) {
    return NextResponse.json({ ok: false, message: 'Cloud sync target URL is not configured.' }, { status: 200 })
  }
  if (!email || (!sharedSecret && !password)) {
    return NextResponse.json({ ok: false, message: 'Cloud sync credentials are not configured. Set OWNER_SYNC_EMAIL and OWNER_SYNC_SHARED_SECRET (or OWNER_SYNC_PASSWORD) in runtime.env.' }, { status: 200 })
  }

  const context = await getRestaurantContextForUser(session.user.id)
  let restaurant = context?.restaurant
  const branchId = context?.branchId ?? null

  if (!restaurant) {
    return NextResponse.json({ ok: false, message: 'No restaurant linked to this account.' }, { status: 200 })
  }

  if (!String((restaurant as any).syncRestaurantId ?? '').trim()) {
    const resolvedIdentity = await resolveCloudRestaurantIdentity({
      restaurant: {
        name: restaurant.name,
        joinCode: (restaurant as any).joinCode,
        syncRestaurantId: (restaurant as any).syncRestaurantId,
      },
      syncTargetUrl: targetUrl,
      syncEmail: requestEmail,
      syncPassword: requestPassword,
      adminEmail: sessionEmail,
    })

    if (!resolvedIdentity.ok) {
      return NextResponse.json({
        ok: false,
        message: `Cloud restaurant identity could not be verified for this desktop. ${resolvedIdentity.error}`,
      }, { status: 200 })
    }

    const nextJoinCode = resolvedIdentity.restaurant.joinCode
    const nextSyncRestaurantId = resolvedIdentity.restaurant.syncRestaurantId
    if (
      nextJoinCode !== ((restaurant as any).joinCode ?? null)
      || nextSyncRestaurantId !== ((restaurant as any).syncRestaurantId ?? null)
    ) {
      const identityUpdate = {
        ...(nextJoinCode ? { joinCode: nextJoinCode } : {}),
        ...(nextSyncRestaurantId ? { syncRestaurantId: nextSyncRestaurantId } : {}),
      }

      const currentRestaurantId = restaurant.id
      restaurant = await prisma.$transaction(async (tx) => {
        if (nextJoinCode) {
          const joinCodeConflict = await tx.restaurant.findFirst({
            where: { joinCode: nextJoinCode, NOT: { id: currentRestaurantId } },
            select: { id: true },
          })

          if (joinCodeConflict) {
            await tx.restaurant.update({
              where: { id: joinCodeConflict.id },
              data: { joinCode: `DISPLACED-${joinCodeConflict.id.slice(-8)}` },
            })
          }
        }

        if (nextSyncRestaurantId) {
          const syncRestaurantConflict = await tx.restaurant.findFirst({
            where: { syncRestaurantId: nextSyncRestaurantId, NOT: { id: currentRestaurantId } },
            select: { id: true },
          })

          if (syncRestaurantConflict) {
            await tx.restaurant.update({
              where: { id: syncRestaurantConflict.id },
              data: { syncRestaurantId: null },
            })
          }
        }

        return tx.restaurant.update({
          where: { id: currentRestaurantId },
          data: identityUpdate,
        })
      })
    }
  }

  const joinCode = (restaurant as any).joinCode ?? null
  const restaurantSyncId = String((restaurant as any).syncRestaurantId ?? '').trim() || null
  if (!joinCode && !restaurantSyncId) {
    return NextResponse.json({ ok: false, message: 'Restaurant cloud identity is not set.' }, { status: 200 })
  }

  const deviceId = getSyncDeviceId()

  const outboxRows = await listPendingSyncOutboxChanges(prisma, {
    scopeIds: [restaurant.id, GLOBAL_SYNC_SCOPE_ID],
    limit: SYNC_MAX_CHANGES_PER_BATCH,
    branchId,
  })

  const changes = mapSyncOutboxRows(outboxRows)

  const { batchId, payloadHash } = buildHybridSyncBatchSignature({
    restaurantSyncId: restaurant.id,
    transactions: [],
    summaries: [],
    changes,
  })

  // Pull cursors so the cloud can return changes we haven't seen yet
  const syncCursors = await prisma.syncCursor.findMany({
    where: { scopeId: { in: [restaurant.id, GLOBAL_SYNC_SCOPE_ID] } },
  })
  const pullCursors = syncCursors.map((cursor) => ({
    scopeId: cursor.scopeId,
    target: cursor.target,
    lastPulledAt: cursor.lastPulledAt?.toISOString() ?? null,
  }))

  // Include branch identity so the cloud can remap branch IDs correctly
  let branchIdentity: { id: string; code: string; name: string; isMain: boolean } | null = null
  if (branchId) {
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, name: true, code: true, isMain: true },
    })
    if (branch) {
      branchIdentity = { id: branch.id, code: branch.code, name: branch.name, isMain: branch.isMain }
    }
  }

  // POST changes to the cloud sync endpoint
  let cloudOk = false
  let cloudError: string | null = null
  let cloudPullChanges: SyncChangeEnvelope[] = []
  let cloudPullCursors: Array<{ scopeId: string; lastPulledAt: string | null }> = []

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-sync-email': email,
      ...(sharedSecret ? { 'x-sync-secret': sharedSecret } : { 'x-sync-password': password }),
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), SYNC_PUSH_TIMEOUT_MS)

    try {
      const res = await fetch(`${targetUrl}/api/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ joinCode, ...(restaurantSyncId ? { restaurantSyncId } : {}), batchId, payloadHash, deviceId, branchId, branchIdentity, changes, pullCursors }),
        signal: controller.signal,
      })
      const payload = await res.json().catch(() => null)
      cloudOk = res.ok
      if (!res.ok) {
        cloudError = String(payload?.error ?? payload?.message ?? `HTTP ${res.status}`)
      } else {
        if (Array.isArray(payload?.pullChanges)) cloudPullChanges = payload.pullChanges
        if (Array.isArray(payload?.pullCursors)) cloudPullCursors = payload.pullCursors
      }
    } finally {
      clearTimeout(timeoutId)
    }
  } catch (err: unknown) {
    cloudError = err instanceof Error ? err.message : 'Network error during cloud sync'
  }

  if (!cloudOk) {
    if (outboxRows.length > 0) {
      await markSyncOutboxChangesFailed(prisma, outboxRows, cloudError ?? 'Sync failed')
    }
    return NextResponse.json({
      ok: false,
      message: cloudError ?? 'Cloud sync failed.',
      consecutiveFailures: 1,
    })
  }

  if (outboxRows.length > 0) {
    await markSyncOutboxChangesSynced(prisma, outboxRows.map((r) => r.id))
  }

  // Apply changes pulled from cloud into the local database
  let pullApplied = 0
  if (cloudPullChanges.length > 0) {
    const pullResult = await applyIncomingSyncChanges(prisma, cloudPullChanges, { localDeviceId: deviceId })
    pullApplied = pullResult.applied
  }

  // Advance pull cursors so the next sync doesn't re-fetch the same changes
  for (const cursor of cloudPullCursors) {
    if (!cursor.scopeId || !cursor.lastPulledAt) continue
    await prisma.syncCursor.upsert({
      where: { scopeId_target: { scopeId: cursor.scopeId, target: targetUrl } },
      update: { lastPulledAt: new Date(cursor.lastPulledAt) },
      create: {
        scopeId: cursor.scopeId,
        target: targetUrl,
        lastPulledAt: new Date(cursor.lastPulledAt),
        lastPushedAt: new Date(0),
      },
    })
  }

  return NextResponse.json({
    ok: true,
    message: changes.length > 0 || pullApplied > 0
      ? `Synced ${changes.length} change(s) to cloud; pulled ${pullApplied} change(s) from cloud.`
      : 'No pending changes to sync.',
    consecutiveFailures: 0,
    syncedTransactions: 0,
    syncedSummaries: 0,
    pullApplied,
  })
}

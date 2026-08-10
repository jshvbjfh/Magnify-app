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

  // Resolve sync credentials — server-managed env vars take precedence over client-provided,
  // but a blank env var (e.g. OWNER_SYNC_EMAIL="" from an unconfigured runtime.env) must not
  // shadow a value the user entered in Settings, so fall through on empty string too.
  const envTargetUrl = String(process.env.OWNER_SYNC_TARGET_URL ?? '').trim()
  const targetUrl = normalizeTargetUrl(
    String(envTargetUrl || body.targetUrl || getCanonicalCloudAppUrl() || '').trim(),
  )
  const sessionEmail = typeof session.user.email === 'string' ? session.user.email.trim().toLowerCase() : ''
  const requestEmail = String(body.email ?? sessionEmail).trim().toLowerCase()
  const requestPassword = String(body.password ?? '').trim()
  const envEmail = String(process.env.OWNER_SYNC_EMAIL ?? '').trim()
  const email = String(envEmail || body.email || sessionEmail || '').trim().toLowerCase()
  const sharedSecret = String(process.env.OWNER_SYNC_SHARED_SECRET ?? '').trim()
  const envPassword = String(process.env.OWNER_SYNC_PASSWORD ?? '').trim()
  const password = sharedSecret ? '' : String(envPassword || body.password || '').trim()

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

  // Pull cursors so the cloud can return changes we haven't seen yet. Must be scoped to
  // *this* target — a cursor left over from syncing a different restaurant (or a different
  // target) on this device must not suppress a fresh pull for a scope we've never synced.
  const syncCursors = await prisma.syncCursor.findMany({
    where: { scopeId: { in: [restaurant.id, GLOBAL_SYNC_SCOPE_ID] }, target: targetUrl },
  })
  const cursorByScope = new Map(syncCursors.map((cursor) => [cursor.scopeId, cursor]))
  const pullCursors = [restaurant.id, GLOBAL_SYNC_SCOPE_ID].map((scopeId) => ({
    scopeId,
    target: targetUrl,
    lastPulledAt: cursorByScope.get(scopeId)?.lastPulledAt?.toISOString() ?? null,
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

  // POST to the cloud sync endpoint, looping the pull side so a device that's badly behind
  // (e.g. catching up after never having synced this restaurant before) fully catches up in
  // one request instead of requiring the caller to click "Sync now" repeatedly — each round
  // trip only returns a bounded page of changes (see SYNC_MAX_CHANGES_PER_BATCH server-side).
  const SYNC_MAX_PULL_ROUNDS = 40

  async function callCloudSync(roundChanges: SyncChangeEnvelope[], roundPullCursors: typeof pullCursors) {
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
        body: JSON.stringify({
          joinCode,
          ...(restaurantSyncId ? { restaurantSyncId } : {}),
          batchId,
          payloadHash,
          deviceId,
          branchId,
          branchIdentity,
          changes: roundChanges,
          pullCursors: roundPullCursors,
        }),
        signal: controller.signal,
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        return { ok: false as const, error: String(payload?.error ?? payload?.message ?? `HTTP ${res.status}`) }
      }
      return {
        ok: true as const,
        pullChanges: Array.isArray(payload?.pullChanges) ? (payload.pullChanges as SyncChangeEnvelope[]) : [],
        pullCursors: Array.isArray(payload?.pullCursors)
          ? (payload.pullCursors as Array<{ scopeId: string; lastPulledAt: string | null }>)
          : [],
      }
    } catch (err: unknown) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'Network error during cloud sync' }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  let totalPullApplied = 0
  let roundPullCursors = pullCursors

  for (let round = 0; round < SYNC_MAX_PULL_ROUNDS; round += 1) {
    const result = await callCloudSync(round === 0 ? changes : [], roundPullCursors)

    if (!result.ok) {
      if (round === 0 && outboxRows.length > 0) {
        await markSyncOutboxChangesFailed(prisma, outboxRows, result.error ?? 'Sync failed')
      }
      return NextResponse.json({
        ok: false,
        message: result.error ?? 'Cloud sync failed.',
        consecutiveFailures: 1,
        pullApplied: totalPullApplied,
      })
    }

    if (round === 0 && outboxRows.length > 0) {
      await markSyncOutboxChangesSynced(prisma, outboxRows.map((r) => r.id))
    }

    if (result.pullChanges.length > 0) {
      const pullResult = await applyIncomingSyncChanges(prisma, result.pullChanges, { localDeviceId: deviceId })
      totalPullApplied += pullResult.applied
    }

    // Advance pull cursors locally so the next round (and the next sync call) doesn't re-fetch
    // changes we've already applied.
    const nextRoundCursors = new Map(roundPullCursors.map((c) => [c.scopeId, c]))
    for (const cursor of result.pullCursors) {
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
      nextRoundCursors.set(cursor.scopeId, { scopeId: cursor.scopeId, target: targetUrl, lastPulledAt: cursor.lastPulledAt })
    }
    roundPullCursors = Array.from(nextRoundCursors.values())

    // A short page means we've caught up — stop looping instead of spending another round trip.
    if (result.pullChanges.length < SYNC_MAX_CHANGES_PER_BATCH) break
  }

  const pushedChanges = changes.length

  return NextResponse.json({
    ok: true,
    message: pushedChanges > 0 || totalPullApplied > 0
      ? `Synced ${pushedChanges} change(s) to cloud; pulled ${totalPullApplied} change(s) from cloud.`
      : 'No pending changes to sync.',
    consecutiveFailures: 0,
    syncedTransactions: 0,
    syncedSummaries: 0,
    pullApplied: totalPullApplied,
  })
}

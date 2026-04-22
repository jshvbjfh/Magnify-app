import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getCanonicalCloudAppUrl } from '@/lib/cloudAuthBridge'
import { prisma } from '@/lib/prisma'
import { buildHybridSyncBatchSignature, buildSyncTransactions, mapSummaryPayload, normalizeTargetUrl, refreshDailySummaries } from '@/lib/minimalSync'
import { ensureRestaurantForOwner, getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { applyIncomingSyncChanges } from '@/lib/syncEngine'
import { logSyncActivity } from '@/lib/syncLogging'
import { enqueueSyncChange, GLOBAL_SYNC_SCOPE_ID, getSyncCursor, getSyncDeviceId, isRestaurantWideSyncEntity, listPendingSyncOutboxChanges, mapSyncOutboxRows, markSyncOutboxChangesFailed, markSyncOutboxChangesSynced, resetSyncOutboxRowsForRetry, updateSyncCursor } from '@/lib/syncOutbox'

async function recordSyncEvent(restaurantId: string, event: { status: 'success' | 'failure'; message: string; syncedTransactions: number; syncedSummaries: number; consecutiveFailures: number }) {
  await prisma.restaurantSyncEvent.create({
    data: {
      restaurantId,
      status: event.status,
      message: event.message,
      syncedTransactions: event.syncedTransactions,
      syncedSummaries: event.syncedSummaries,
      consecutiveFailures: event.consecutiveFailures,
    },
  })
}

async function markSyncFailure(restaurantId: string, message: string) {
  const now = new Date()
  const state = await prisma.restaurantSyncState.upsert({
    where: { restaurantId },
    create: {
      restaurantId,
      lastAttemptAt: now,
      lastErrorAt: now,
      lastErrorMessage: message,
      consecutiveFailures: 1,
      lastSyncedTransactions: 0,
      lastSyncedSummaries: 0,
    },
    update: {
      lastAttemptAt: now,
      lastErrorAt: now,
      lastErrorMessage: message,
      consecutiveFailures: { increment: 1 },
      lastSyncedTransactions: 0,
      lastSyncedSummaries: 0,
    },
  })

  await recordSyncEvent(restaurantId, {
    status: 'failure',
    message,
    syncedTransactions: 0,
    syncedSummaries: 0,
    consecutiveFailures: state.consecutiveFailures,
  })

  return state
}

async function markSyncSuccess(restaurantId: string, counts: { transactions: number; summaries: number }, message?: string) {
  const now = new Date()
  const state = await prisma.restaurantSyncState.upsert({
    where: { restaurantId },
    create: {
      restaurantId,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastErrorAt: null,
      lastErrorMessage: null,
      consecutiveFailures: 0,
      lastSyncedTransactions: counts.transactions,
      lastSyncedSummaries: counts.summaries,
    },
    update: {
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastErrorAt: null,
      lastErrorMessage: null,
      consecutiveFailures: 0,
      lastSyncedTransactions: counts.transactions,
      lastSyncedSummaries: counts.summaries,
    },
  })

  await recordSyncEvent(restaurantId, {
    status: 'success',
    message: message || (counts.transactions === 0 && counts.summaries === 0 ? 'No data to sync' : 'Owner cloud sync completed successfully'),
    syncedTransactions: counts.transactions,
    syncedSummaries: counts.summaries,
    consecutiveFailures: state.consecutiveFailures,
  })

  return state
}

function pickFirstNonEmpty(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const normalized = String(value ?? '').trim()
    if (normalized) return normalized
  }
  return ''
}

function pickFirstSecret(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

function remapPulledRestaurantScopeChanges(
  changes: Array<{ scopeId?: string; restaurantId?: string | null; entityType?: string; entityId?: string; payload?: unknown }>,
  localRestaurantId: string,
) {
  for (const change of changes) {
    const scopeId = String(change.scopeId ?? '').trim()
    if (!scopeId || scopeId === GLOBAL_SYNC_SCOPE_ID) {
      change.restaurantId = null
      continue
    }

    change.restaurantId = localRestaurantId

    if (change.payload && typeof change.payload === 'object') {
      const payload = change.payload as Record<string, unknown>
      if (typeof payload.restaurantId === 'string' && payload.restaurantId !== localRestaurantId) {
        payload.restaurantId = localRestaurantId
      }

      if (change.entityType === 'restaurant') {
        change.entityId = localRestaurantId
        payload.id = localRestaurantId
      }
    }
  }
}

function isBranchVisibleChange(
  change: { scopeId?: string; branchId?: string | null; entityType?: string },
  branchId: string | null,
) {
  const scopeId = String(change.scopeId ?? '').trim()
  if (scopeId === GLOBAL_SYNC_SCOPE_ID) return true
  if (isRestaurantWideSyncEntity(change.entityType)) return true
  return String(change.branchId ?? '') === String(branchId ?? '')
}

async function requireRestaurantSyncUser() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) throw new Error('Unauthorized')
  const user = session.user as any
  if (!['admin', 'waiter', 'kitchen'].includes(String(user.role))) throw new Error('Forbidden')
  return {
    id: session.user.id,
    email: typeof session.user.email === 'string' ? session.user.email.trim().toLowerCase() : '',
    role: String(user.role),
  }
}

/**
 * Seed the SyncOutbox with ALL existing restaurant data when the outbox is empty
 * (first-ever sync). This ensures a new device pulling from cloud gets all data.
 */
async function seedFullSnapshotIfNeeded(restaurantId: string, billingUserId: string, branchId: string | null) {
  const existingOutbox = await prisma.syncOutbox.count({
    where: {
      scopeId: restaurantId,
      branchId: branchId ?? null,
    },
  })
  if (existingOutbox > 0) return false // already has outbox history

  const [restaurant, branches, dishes, inventoryItems, employees, tables, orders, wasteLogs, inventoryPurchases, inventoryBatchUsageLedgers, inventoryAdjustmentLogs, shifts, dishSales] = await Promise.all([
    prisma.restaurant.findUnique({ where: { id: restaurantId } }),
    prisma.restaurantBranch.findMany({ where: { restaurantId, isActive: true } }),
    prisma.dish.findMany({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) } }),
    prisma.inventoryItem.findMany({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) } }),
    prisma.employee.findMany({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) } }),
    prisma.restaurantTable.findMany({ where: { restaurantId, ...(branchId ? { branchId } : {}) } }),
    prisma.restaurantOrder.findMany({ where: { restaurantId, ...(branchId ? { branchId } : {}) }, include: { items: true } }),
    prisma.wasteLog.findMany({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) } }),
    prisma.inventoryPurchase.findMany({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) } }),
    prisma.inventoryBatchUsageLedger.findMany({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) } }),
    prisma.inventoryAdjustmentLog.findMany({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) } }),
    prisma.shift.findMany({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) } }),
    prisma.dishSale.findMany({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) }, include: { saleIngredients: true } }),
  ])

  const branchScopedEntityCount = dishes.length + inventoryItems.length + employees.length + tables.length +
    orders.length + wasteLogs.length + inventoryPurchases.length + dishSales.length +
    inventoryBatchUsageLedgers.length + inventoryAdjustmentLogs.length + shifts.length

  if (branchScopedEntityCount === 0) return false

  const enqueue = (entityType: string, entityId: string, payload: unknown, entityBranchId: string | null = branchId) =>
    enqueueSyncChange(prisma, { restaurantId, branchId: entityBranchId, entityType, entityId, operation: 'upsert', payload })

  if (restaurant) await enqueue('restaurant', restaurant.id, restaurant)
  for (const row of branches) await enqueue('restaurantBranch', row.id, row, null)
  for (const row of dishes) await enqueue('dish', row.id, row)
  for (const row of inventoryItems) await enqueue('inventoryItem', row.id, row)
  for (const row of employees) await enqueue('employee', row.id, row)
  for (const row of tables) await enqueue('restaurantTable', row.id, row)
  for (const row of wasteLogs) await enqueue('wasteLog', row.id, row)
  for (const row of inventoryPurchases) await enqueue('inventoryPurchase', row.id, row)
  for (const row of inventoryBatchUsageLedgers) await enqueue('inventoryBatchUsageLedger', row.id, row)
  for (const row of inventoryAdjustmentLogs) await enqueue('inventoryAdjustmentLog', row.id, row)
  for (const row of shifts) await enqueue('shift', row.id, row)
  for (const row of dishSales) await enqueue('dishSale', row.id, { ...row, saleIngredients: row.saleIngredients })
  for (const row of orders) await enqueue('restaurantOrder', row.id, row)

  // Also enqueue dishIngredients
  const dishIngredients = await prisma.dishIngredient.findMany({
    where: { dish: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) } },
  })
  for (const row of dishIngredients) {
    await enqueueSyncChange(prisma, {
      restaurantId,
      branchId,
      entityType: 'dishIngredient',
      entityId: `${row.dishId}_${row.ingredientId}`,
      operation: 'upsert',
      payload: row,
    })
  }

  const total = branches.length + dishes.length + inventoryItems.length + employees.length + tables.length +
    orders.length + wasteLogs.length + inventoryPurchases.length + dishSales.length +
    inventoryBatchUsageLedgers.length + inventoryAdjustmentLogs.length + shifts.length +
    dishIngredients.length + (restaurant ? 1 : 0)

  if (total > 0) {
    logSyncActivity('info', 'sync.local.snapshot_seeded', { restaurantId, totalEntities: total })
  }

  return total > 0
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
    const syncUser = await requireRestaurantSyncUser()
    const userId = syncUser.id
    const context = await getRestaurantContextForUser(userId)
    const restaurant = context?.restaurantId
      ? context.restaurant
      : syncUser.role === 'admin'
        ? await ensureRestaurantForOwner(userId)
        : null
    const deviceId = getSyncDeviceId()

    if (!restaurant || !context?.billingUserId && syncUser.role !== 'admin') {
      return NextResponse.json({ error: 'No restaurant is linked to this account yet' }, { status: 409 })
    }

    const billingUserId = context?.billingUserId ?? userId
    const branchId = context?.branchId ?? null

    if (!restaurant.syncRestaurantId || !restaurant.syncToken) {
      const state = await markSyncFailure(restaurant.id, 'Branch sync identity is missing; relink this branch before retrying cloud sync')
      logSyncActivity('warn', 'sync.local.blocked', {
        restaurantId: restaurant.id,
        deviceId,
        reason: 'missing_branch_identity',
        consecutiveFailures: state.consecutiveFailures,
      })
      return NextResponse.json({ ok: false, message: 'Sync failed', consecutiveFailures: state.consecutiveFailures }, { status: 409 })
    }

    const body = await req.json().catch(() => ({}))
    const targetUrl = pickFirstNonEmpty(body.targetUrl, process.env.OWNER_SYNC_TARGET_URL, getCanonicalCloudAppUrl())
    const password = pickFirstSecret(body.password, process.env.OWNER_SYNC_PASSWORD)
    const sharedSecret = String(process.env.OWNER_SYNC_SHARED_SECRET ?? '').trim()
    const email = sharedSecret
      ? pickFirstNonEmpty(body.email, syncUser.email, process.env.OWNER_SYNC_EMAIL).toLowerCase()
      : pickFirstNonEmpty(body.email, process.env.OWNER_SYNC_EMAIL, syncUser.email).toLowerCase()

    if (!targetUrl || !email || (!password && !sharedSecret)) {
      return NextResponse.json({ error: 'Sync target, sync email, and server-managed secret or password are required' }, { status: 400 })
    }

    const online = await hasInternet(targetUrl)
    if (!online) {
      const state = await markSyncFailure(restaurant.id, 'Internet or cloud target unavailable')
      logSyncActivity('warn', 'sync.local.failed', {
        restaurantId: restaurant.id,
        deviceId,
        reason: 'target_unavailable',
        consecutiveFailures: state.consecutiveFailures,
      })
      return NextResponse.json({ ok: false, message: 'Sync failed', consecutiveFailures: state.consecutiveFailures }, { status: 503 })
    }

    const unsyncedTransactions = await prisma.transaction.findMany({
      where: { userId: billingUserId, restaurantId: restaurant.id, ...(branchId ? { branchId } : {}), synced: false },
      include: {
        account: { select: { name: true } },
        category: { select: { type: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    const affectedDates = unsyncedTransactions.map((row) => row.date).map((date) => {
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    })

    // Also refresh summaries for all existing daily-summary dates so that any
    // formula changes (e.g. revenue calculation) are always re-applied and
    // re-synced, even if the underlying transactions were already marked synced.
    const existingSummaries = await prisma.dailySummary.findMany({
      where: { userId: billingUserId, restaurantId: restaurant.id, ...(branchId ? { branchId } : {}) },
      select: { date: true },
    })
    const summaryDates = existingSummaries.map((row) => {
      const d = row.date
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    })
    const allDatesToRefresh = Array.from(new Set([...affectedDates, ...summaryDates]))

    await refreshDailySummaries(prisma, billingUserId, allDatesToRefresh, restaurant.id, branchId)

    // On first-ever sync, seed outbox with all existing data so cloud gets everything
    await seedFullSnapshotIfNeeded(restaurant.id, billingUserId, branchId)

    const unsyncedSummaries = await prisma.dailySummary.findMany({
      where: { userId: billingUserId, restaurantId: restaurant.id, ...(branchId ? { branchId } : {}), synced: false },
      orderBy: { date: 'asc' },
    })

    const [restaurantCursor, globalCursor, pendingOutboxRows] = await Promise.all([
      getSyncCursor(prisma, { scopeId: restaurant.id, restaurantId: restaurant.id }),
      getSyncCursor(prisma, { scopeId: GLOBAL_SYNC_SCOPE_ID, restaurantId: restaurant.id }),
      listPendingSyncOutboxChanges(prisma, { scopeIds: [restaurant.id, GLOBAL_SYNC_SCOPE_ID], limit: 30, branchId }),
    ])

    const { transactions, syncedIds } = buildSyncTransactions(unsyncedTransactions)
    const summaries = mapSummaryPayload(unsyncedSummaries)
    const changes = mapSyncOutboxRows(pendingOutboxRows)
    const { batchId, payloadHash } = buildHybridSyncBatchSignature({
      restaurantSyncId: restaurant.syncRestaurantId,
      transactions,
      summaries,
      changes,
    })

    logSyncActivity('info', 'sync.local.started', {
      restaurantId: restaurant.id,
      restaurantSyncId: restaurant.syncRestaurantId,
      deviceId,
      batchId,
      transactions: transactions.length,
      summaries: summaries.length,
      changes: changes.length,
    })

    // Fetch local user's name and password hash so cloud can auto-provision if needed
    const localUser = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, password: true, role: true } })

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
        branchId,
        batchId,
        payloadHash,
        deviceId,
        protocolVersion: 2,
        provisionUser: localUser ? { name: localUser.name, passwordHash: localUser.password, role: localUser.role } : undefined,
        transactions,
        summaries,
        changes,
        pullCursors: [
          {
            scopeId: restaurant.id,
            lastPulledAt: restaurantCursor.lastPulledAt?.toISOString() ?? null,
            lastMutationId: restaurantCursor.lastMutationId ?? null,
          },
          {
            scopeId: GLOBAL_SYNC_SCOPE_ID,
            lastPulledAt: globalCursor.lastPulledAt?.toISOString() ?? null,
            lastMutationId: globalCursor.lastMutationId ?? null,
          },
        ],
      }),
    })

    if (!res.ok) {
      const payload = await res.json().catch(() => null)
      const linkedRestaurant = payload?.linkedRestaurant
      const linkedSyncRestaurantId = typeof linkedRestaurant?.syncRestaurantId === 'string'
        ? linkedRestaurant.syncRestaurantId.trim()
        : ''
      const linkedSyncToken = typeof linkedRestaurant?.syncToken === 'string'
        ? linkedRestaurant.syncToken
        : ''

      if (res.status === 409 && linkedSyncRestaurantId && linkedSyncToken && linkedSyncRestaurantId !== restaurant.syncRestaurantId) {
        await prisma.restaurant.update({
          where: { id: restaurant.id },
          data: {
            name: typeof linkedRestaurant?.name === 'string' && linkedRestaurant.name
              ? linkedRestaurant.name
              : restaurant.name,
            syncRestaurantId: linkedSyncRestaurantId,
            syncToken: linkedSyncToken,
          },
        })

        await resetSyncOutboxRowsForRetry(prisma, {
          scopeIds: [restaurant.id, GLOBAL_SYNC_SCOPE_ID],
          onlyExhausted: true,
        })

        const message = 'Branch identity refreshed from cloud. Retry sync to continue.'
        const state = await markSyncFailure(restaurant.id, message)
        logSyncActivity('warn', 'sync.local.relinked', {
          restaurantId: restaurant.id,
          oldRestaurantSyncId: restaurant.syncRestaurantId,
          newRestaurantSyncId: linkedSyncRestaurantId,
          deviceId,
          batchId,
        })
        return NextResponse.json({ ok: false, relinked: true, message, consecutiveFailures: state.consecutiveFailures }, { status: 409 })
      }

      if (pendingOutboxRows.length > 0) {
        await markSyncOutboxChangesFailed(prisma, pendingOutboxRows, payload?.error || 'Sync failed')
      }
      const state = await markSyncFailure(restaurant.id, payload?.error || 'Sync failed')
      logSyncActivity('warn', 'sync.local.failed', {
        restaurantId: restaurant.id,
        restaurantSyncId: restaurant.syncRestaurantId,
        deviceId,
        batchId,
        consecutiveFailures: state.consecutiveFailures,
        error: payload?.error || 'Sync failed',
      })
      return NextResponse.json({ ok: false, message: payload?.error || 'Sync failed', consecutiveFailures: state.consecutiveFailures }, { status: res.status })
    }

    const payload = await res.json().catch(() => null)

    if (payload?.batchId && String(payload.batchId) !== batchId) {
      if (pendingOutboxRows.length > 0) {
        await markSyncOutboxChangesFailed(prisma, pendingOutboxRows, 'Cloud sync batch acknowledgement mismatch')
      }
      const state = await markSyncFailure(restaurant.id, 'Cloud sync batch acknowledgement mismatch')
      logSyncActivity('warn', 'sync.local.failed', {
        restaurantId: restaurant.id,
        restaurantSyncId: restaurant.syncRestaurantId,
        deviceId,
        batchId,
        consecutiveFailures: state.consecutiveFailures,
        error: 'Cloud sync batch acknowledgement mismatch',
      })
      return NextResponse.json({ ok: false, message: 'Sync failed', consecutiveFailures: state.consecutiveFailures }, { status: 502 })
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

    if (pendingOutboxRows.length > 0) {
      await markSyncOutboxChangesSynced(prisma, pendingOutboxRows.map((row) => row.id))
    }

    // Reset any exhausted outbox entries so they get retried on the next sync cycle
    await resetSyncOutboxRowsForRetry(prisma, {
      scopeIds: [restaurant.id, GLOBAL_SYNC_SCOPE_ID],
      branchId,
      onlyExhausted: true,
    })

    const pulledChanges = Array.isArray(payload?.pullChanges)
      ? payload.pullChanges.filter((change: any) => isBranchVisibleChange(change, branchId))
      : []
    const pullCursors = Array.isArray(payload?.pullCursors) ? payload.pullCursors : []
    let appliedChanges = 0
    let conflictCount = 0

    if (pulledChanges.length > 0) {
      remapPulledRestaurantScopeChanges(pulledChanges, restaurant.id)
    }

    await prisma.$transaction(async (tx) => {
      if (pulledChanges.length > 0) {
        const appliedResult = await applyIncomingSyncChanges(tx, pulledChanges, {
          localDeviceId: deviceId,
          remapUserId: billingUserId,
        })
        appliedChanges = appliedResult.applied
        conflictCount = appliedResult.conflicts
      }

      for (const cursor of pullCursors) {
        await updateSyncCursor(tx, {
          scopeId: String(cursor.scopeId),
          restaurantId: restaurant.id,
          lastPulledAt: cursor.lastPulledAt ? new Date(String(cursor.lastPulledAt)) : null,
          lastMutationId: cursor.lastMutationId ? String(cursor.lastMutationId) : null,
        })
      }
    })

    if (changes.length > 0) {
      await Promise.all([
        updateSyncCursor(prisma, {
          scopeId: restaurant.id,
          restaurantId: restaurant.id,
          lastPushedAt: new Date(),
          lastMutationId: changes.filter((change) => change.scopeId === restaurant.id).at(-1)?.mutationId ?? restaurantCursor.lastMutationId,
        }),
        updateSyncCursor(prisma, {
          scopeId: GLOBAL_SYNC_SCOPE_ID,
          restaurantId: restaurant.id,
          lastPushedAt: new Date(),
          lastMutationId: changes.filter((change) => change.scopeId === GLOBAL_SYNC_SCOPE_ID).at(-1)?.mutationId ?? globalCursor.lastMutationId,
        }),
      ])
    }

    const noOutboundChanges = transactions.length === 0 && summaries.length === 0 && changes.length === 0
    const noPulledChanges = pulledChanges.length === 0
    const syncMessage = payload?.message || (noOutboundChanges && noPulledChanges
      ? 'No local or remote changes to sync'
      : 'Owner cloud sync completed successfully')

    await markSyncSuccess(restaurant.id, {
      transactions: Number(payload?.transactions ?? transactions.length),
      summaries: Number(payload?.summaries ?? summaries.length),
    }, syncMessage)

    logSyncActivity(conflictCount > 0 ? 'warn' : 'info', 'sync.local.completed', {
      restaurantId: restaurant.id,
      restaurantSyncId: restaurant.syncRestaurantId,
      deviceId,
      batchId,
      syncedTransactions: Number(payload?.transactions ?? transactions.length),
      syncedSummaries: Number(payload?.summaries ?? summaries.length),
      pushedChanges: Number(payload?.changes ?? changes.length),
      pulledChanges: pulledChanges.length,
      appliedChanges,
      conflictCount,
      message: syncMessage,
    })
    return NextResponse.json({
      ok: true,
      message: syncMessage,
      consecutiveFailures: 0,
      batchId,
      syncedTransactions: Number(payload?.transactions ?? transactions.length),
      syncedSummaries: Number(payload?.summaries ?? summaries.length),
      pushedChanges: Number(payload?.changes ?? changes.length),
      pulledChanges: pulledChanges.length,
      appliedChanges,
      conflictCount,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed'
    const userId = await getServerSession(authOptions).then((session) => session?.user?.id).catch(() => null)
    let restaurantId: string | null = null
    if (userId) {
      const context = await getRestaurantContextForUser(userId).catch(() => null)
      const restaurant = context?.restaurant ?? await ensureRestaurantForOwner(userId).catch(() => null)
      if (restaurant) {
        restaurantId = restaurant.id
        await markSyncFailure(restaurant.id, message)
      }
    }
    const status = message === 'Unauthorized' ? 401 : message === 'Forbidden' ? 403 : 500
    logSyncActivity('error', 'sync.local.failed', {
      restaurantId,
      deviceId: getSyncDeviceId(),
      error: message,
      status,
    })
    return NextResponse.json({ error: message }, { status })
  }
}
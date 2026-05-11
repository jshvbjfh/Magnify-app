import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getCanonicalCloudAppUrl, isLocalFirstDesktopAuthBridgeEnabled } from '@/lib/cloudAuthBridge'
import { prisma } from '@/lib/prisma'
import { buildHybridSyncBatchSignature, buildSyncTransactions, mapSummaryPayload, normalizeTargetUrl, refreshDailySummaries } from '@/lib/minimalSync'
import { ensureRestaurantForOwner, getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { applyIncomingSyncChanges } from '@/lib/syncEngine'
import { logSyncActivity } from '@/lib/syncLogging'
import { enqueueSyncChange, GLOBAL_SYNC_SCOPE_ID, getSyncCursor, getSyncDeviceId, isRestaurantWideSyncEntity, latestSyncChangeTimestamp, latestSyncMutationId, listPendingSyncOutboxChanges, mapSyncOutboxRows, markSyncOutboxChangesFailed, markSyncOutboxChangesSynced, resetSyncOutboxRowsForRetry, SYNC_OUTBOX_MAX_ATTEMPTS, type SyncChangeEnvelope, updateSyncCursor } from '@/lib/syncOutbox'

function canAutoCreateRestaurantContext() {
  return !isLocalFirstDesktopAuthBridgeEnabled()
}

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

async function upsertLocalSyncBatch(
  restaurantId: string,
  batchId: string,
  payloadHash: string,
  params: {
    status: 'processing' | 'success' | 'failed'
    errorMessage?: string | null
    syncedTransactions?: number
    syncedSummaries?: number
    appliedAt?: Date | null
  },
) {
  await prisma.restaurantSyncBatch.upsert({
    where: {
      restaurantId_batchId: {
        restaurantId,
        batchId,
      },
    },
    create: {
      restaurantId,
      batchId,
      payloadHash,
      status: params.status,
      errorMessage: params.errorMessage ?? null,
      syncedTransactions: params.syncedTransactions ?? 0,
      syncedSummaries: params.syncedSummaries ?? 0,
      ...(params.appliedAt ? { appliedAt: params.appliedAt } : {}),
    },
    update: {
      payloadHash,
      status: params.status,
      errorMessage: params.errorMessage ?? null,
      syncedTransactions: params.syncedTransactions ?? 0,
      syncedSummaries: params.syncedSummaries ?? 0,
      appliedAt: params.appliedAt ?? null,
    },
  })
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

function normalizeSyncBranchValue(value: unknown) {
  return String(value ?? '').trim()
}

async function remapPulledBranchIds(
  changes: Array<{ branchId?: string | null; entityType?: string; entityId?: string; operation?: string; payload?: unknown }>,
  localRestaurantId: string,
  localBranchId: string | null,
) {
  const localBranches = await prisma.restaurantBranch.findMany({
    where: { restaurantId: localRestaurantId },
    select: { id: true, name: true, code: true, isMain: true, isActive: true },
    orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  })

  if (localBranches.length === 0) return

  const localBranchIds = new Set(localBranches.map((branch) => branch.id))
  const cloudToLocalBranchId = new Map<string, string>()
  const activeLocalBranches = localBranches.filter((branch) => branch.isActive)
  const fallbackLocalBranchId = localBranchId && localBranchIds.has(localBranchId)
    ? localBranchId
    : activeLocalBranches.length === 1
      ? activeLocalBranches[0].id
      : null

  for (const change of changes) {
    if (change.entityType !== 'restaurantBranch' || change.operation === 'delete') continue

    const payload = change.payload && typeof change.payload === 'object'
      ? change.payload as Record<string, unknown>
      : null

    const incomingCloudBranchId = normalizeSyncBranchValue(payload?.id ?? change.entityId)
    if (!incomingCloudBranchId) continue

    if (localBranchIds.has(incomingCloudBranchId)) {
      cloudToLocalBranchId.set(incomingCloudBranchId, incomingCloudBranchId)
      continue
    }

    const incomingCode = normalizeSyncBranchValue(payload?.code)
    const incomingName = normalizeSyncBranchValue(payload?.name)
    const incomingIsMain = Boolean(payload?.isMain)

    const localBranch = localBranches.find((branch) => incomingCode && branch.code === incomingCode)
      ?? localBranches.find((branch) => incomingName && branch.name === incomingName)
      ?? (incomingIsMain ? activeLocalBranches.find((branch) => branch.isMain) : undefined)
      ?? (fallbackLocalBranchId ? localBranches.find((branch) => branch.id === fallbackLocalBranchId) : undefined)

    if (!localBranch) continue
    cloudToLocalBranchId.set(incomingCloudBranchId, localBranch.id)

    change.entityId = localBranch.id
    if (payload) {
      payload.id = localBranch.id
      payload.restaurantId = localRestaurantId
    }
  }

  for (const change of changes) {
    if (isRestaurantWideSyncEntity(change.entityType)) continue

    const payload = change.payload && typeof change.payload === 'object'
      ? change.payload as Record<string, unknown>
      : null

    const incomingBranchId = normalizeSyncBranchValue(change.branchId ?? payload?.branchId)
    if (!incomingBranchId) continue

    const resolvedBranchId = cloudToLocalBranchId.get(incomingBranchId)
      ?? (localBranchIds.has(incomingBranchId) ? incomingBranchId : fallbackLocalBranchId)

    if (!resolvedBranchId) continue

    change.branchId = resolvedBranchId
    if (payload && (payload.branchId != null || resolvedBranchId != null)) {
      payload.branchId = resolvedBranchId
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
  // Guard: check ANY outbox row for this restaurant scope (not just branch-scoped).
  // Previously queried branchId: branchId ?? null which meant null-branch devices skipped
  // the seed because ensureEssentialSyncIdentityRows already created restaurant-level rows.
  const existingOutbox = await prisma.syncOutbox.count({
    where: { scopeId: restaurantId },
  })
  if (existingOutbox > 0) return false // already has outbox history

  const branchScopedWhere = branchId ? { branchId } : {}
  const resolveEntityBranchId = (row: { branchId?: string | null }) => row.branchId ?? branchId ?? null

  const [restaurant, branches, dishes, inventoryItems, employees, tables, orders, wasteLogs, inventoryPurchases, inventoryBatchUsageLedgers, inventoryAdjustmentLogs, shifts, dishSales, transactions] = await Promise.all([
    prisma.restaurant.findUnique({ where: { id: restaurantId } }),
    prisma.restaurantBranch.findMany({ where: { restaurantId, isActive: true } }),
    prisma.dish.findMany({ where: { userId: billingUserId, restaurantId, ...branchScopedWhere } }),
    prisma.inventoryItem.findMany({ where: { userId: billingUserId, restaurantId, ...branchScopedWhere } }),
    prisma.employee.findMany({ where: { userId: billingUserId, restaurantId, ...branchScopedWhere } }),
    prisma.restaurantTable.findMany({ where: { restaurantId, ...branchScopedWhere } }),
    prisma.restaurantOrder.findMany({ where: { restaurantId, ...branchScopedWhere }, include: { items: true } }),
    prisma.wasteLog.findMany({ where: { userId: billingUserId, restaurantId, ...branchScopedWhere } }),
    prisma.inventoryPurchase.findMany({ where: { userId: billingUserId, restaurantId, ...branchScopedWhere } }),
    prisma.inventoryBatchUsageLedger.findMany({ where: { userId: billingUserId, restaurantId, ...branchScopedWhere } }),
    prisma.inventoryAdjustmentLog.findMany({ where: { userId: billingUserId, restaurantId, ...branchScopedWhere } }),
    prisma.shift.findMany({ where: { userId: billingUserId, restaurantId, ...branchScopedWhere } }),
    prisma.dishSale.findMany({ where: { userId: billingUserId, restaurantId, ...branchScopedWhere }, include: { saleIngredients: true } }),
    prisma.transaction.findMany({
      where: { userId: billingUserId, restaurantId, ...branchScopedWhere },
      include: { category: { select: { type: true } } },
    }),
  ])

  const branchScopedEntityCount = dishes.length + inventoryItems.length + employees.length + tables.length +
    orders.length + wasteLogs.length + inventoryPurchases.length + dishSales.length + transactions.length +
    inventoryBatchUsageLedgers.length + inventoryAdjustmentLogs.length + shifts.length

  if (branchScopedEntityCount === 0) return false

  const enqueue = (entityType: string, entityId: string, payload: unknown, entityBranchId: string | null = branchId) =>
    enqueueSyncChange(prisma, { restaurantId, branchId: entityBranchId, entityType, entityId, operation: 'upsert', payload })

  if (restaurant) await enqueue('restaurant', restaurant.id, restaurant)
  for (const row of branches) await enqueue('restaurantBranch', row.id, row, null)
  for (const row of dishes) await enqueue('dish', row.id, row, resolveEntityBranchId(row))
  for (const row of inventoryItems) await enqueue('inventoryItem', row.id, row, resolveEntityBranchId(row))
  for (const row of employees) await enqueue('employee', row.id, row, resolveEntityBranchId(row))
  for (const row of tables) await enqueue('restaurantTable', row.id, row, resolveEntityBranchId(row))
  for (const row of wasteLogs) await enqueue('wasteLog', row.id, row, resolveEntityBranchId(row))
  for (const row of inventoryPurchases) await enqueue('inventoryPurchase', row.id, row, resolveEntityBranchId(row))
  for (const row of inventoryBatchUsageLedgers) await enqueue('inventoryBatchUsageLedger', row.id, row, resolveEntityBranchId(row))
  for (const row of inventoryAdjustmentLogs) await enqueue('inventoryAdjustmentLog', row.id, row, resolveEntityBranchId(row))
  for (const row of shifts) await enqueue('shift', row.id, row, resolveEntityBranchId(row))
  for (const row of dishSales) await enqueue('dishSale', row.id, { ...row, saleIngredients: row.saleIngredients }, resolveEntityBranchId(row))
  for (const row of transactions) {
    await enqueue('transaction', row.id, {
      ...row,
      categoryType: row.category?.type ?? null,
    }, resolveEntityBranchId(row))
  }
  // Orders are enqueued with their items embedded so the sync engine can recreate
  // RestaurantOrderItem rows on the cloud side (they have no standalone sync entity).
  for (const row of orders) await enqueue('restaurantOrder', row.id, { ...row, items: row.items }, resolveEntityBranchId(row))

  // Also enqueue dishIngredients
  const dishIngredients = await prisma.dishIngredient.findMany({
    where: { dish: { userId: billingUserId, restaurantId, ...branchScopedWhere } },
    include: {
      dish: {
        select: {
          branchId: true,
        },
      },
    },
  })
  for (const row of dishIngredients) {
    const { dish, ...payload } = row
    await enqueueSyncChange(prisma, {
      restaurantId,
      branchId: dish.branchId ?? branchId ?? null,
      entityType: 'dishIngredient',
      // S4: Use colon separator to match live outbox rows (dishId:ingredientId).
      // Underscore was wrong \u2014 conflict detection compares entityId strings exactly.
      entityId: `${row.dishId}:${row.ingredientId}`,
      operation: 'upsert',
      payload,
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

async function ensureEssentialSyncIdentityRows(restaurantId: string) {
  const [restaurant, branches, existingRows] = await Promise.all([
    prisma.restaurant.findUnique({ where: { id: restaurantId } }),
    prisma.restaurantBranch.findMany({ where: { restaurantId, isActive: true } }),
    prisma.syncOutbox.findMany({
      where: {
        scopeId: restaurantId,
        entityType: { in: ['restaurant', 'restaurantBranch'] },
      },
      select: {
        entityType: true,
        entityId: true,
      },
    }),
  ])

  const existingKeys = new Set(existingRows.map((row) => `${row.entityType}:${row.entityId}`))

  if (restaurant && !existingKeys.has(`restaurant:${restaurant.id}`)) {
    await enqueueSyncChange(prisma, {
      restaurantId,
      branchId: null,
      entityType: 'restaurant',
      entityId: restaurant.id,
      operation: 'upsert',
      payload: restaurant,
    })
  }

  for (const branch of branches) {
    if (existingKeys.has(`restaurantBranch:${branch.id}`)) continue
    await enqueueSyncChange(prisma, {
      restaurantId,
      branchId: null,
      entityType: 'restaurantBranch',
      entityId: branch.id,
      operation: 'upsert',
      payload: branch,
    })
  }
}

async function listPrioritizedPendingSyncOutboxChanges(restaurantId: string, branchId: string | null | undefined, limit: number) {
  const now = new Date()
  const priorityRows = await prisma.syncOutbox.findMany({
    where: {
      scopeId: restaurantId,
      entityType: { in: ['restaurant', 'restaurantBranch'] },
      syncedAt: null,
      attempts: { lt: SYNC_OUTBOX_MAX_ATTEMPTS },
      OR: [
        { availableAt: null },
        { availableAt: { lte: now } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  })

  const regularRows = await listPendingSyncOutboxChanges(prisma, {
    scopeIds: [restaurantId, GLOBAL_SYNC_SCOPE_ID],
    limit,
    branchId,
  })

  const seenIds = new Set<string>()
  return [...priorityRows, ...regularRows].filter((row) => {
    if (seenIds.has(row.id)) return false
    seenIds.add(row.id)
    return true
  }).slice(0, limit)
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
  let activeBatch: { restaurantId: string; batchId: string; payloadHash: string } | null = null

  try {
    const syncUser = await requireRestaurantSyncUser()
    const userId = syncUser.id
    const context = await getRestaurantContextForUser(userId)

    // Guard: if context is null, verify the user actually exists in DB before
    // attempting auto-create. A deleted user's JWT can remain valid; calling
    // ensureRestaurantForOwner with a non-existent userId causes a FK violation.
    const restaurant = context?.restaurant ?? await (async () => {
      if (syncUser.role !== 'admin' || !canAutoCreateRestaurantContext()) return null
      const userExists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
      if (!userExists) return null
      return ensureRestaurantForOwner(userId)
    })()
    const deviceId = getSyncDeviceId()
    const missingRestaurantMessage = canAutoCreateRestaurantContext()
      ? 'No restaurant is linked to this account yet'
      : 'No restaurant is linked to this device yet. Retry bootstrap sync before continuing.'

    if (!restaurant || !context?.billingUserId && syncUser.role !== 'admin') {
      return NextResponse.json({ ok: false, error: missingRestaurantMessage, message: missingRestaurantMessage }, { status: 409 })
    }

    const billingUserId = context?.billingUserId ?? userId
    const branchId = context?.branchId ?? null
    const branchIdentity = branchId
      ? await prisma.restaurantBranch.findUnique({
          where: { id: branchId },
          select: { id: true, code: true, name: true, isMain: true },
        })
      : null

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
    const configuredOwnerEmail = String(process.env.OWNER_SYNC_EMAIL ?? '').trim().toLowerCase()
    const email = sharedSecret
      ? pickFirstNonEmpty(configuredOwnerEmail, body.email, syncUser.email).toLowerCase()
      : pickFirstNonEmpty(body.email, configuredOwnerEmail, syncUser.email).toLowerCase()

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
      // Use Kigali timezone so dates are not shifted to the previous UTC day
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(date)
    })

    // Also refresh summaries for all existing daily-summary dates so that any
    // formula changes (e.g. revenue calculation) are always re-applied and
    // re-synced, even if the underlying transactions were already marked synced.
    const existingSummaries = await prisma.dailySummary.findMany({
      where: { userId: billingUserId, restaurantId: restaurant.id, ...(branchId ? { branchId } : {}) },
      select: { date: true },
    })
    const summaryDates = existingSummaries.map((row) => {
      // Use Kigali timezone — summary dates stored at UTC noon fall on the correct Kigali day
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(row.date)
    })
    const allDatesToRefresh = Array.from(new Set([...affectedDates, ...summaryDates]))

    await refreshDailySummaries(prisma, billingUserId, allDatesToRefresh, restaurant.id, branchId)

    // On first-ever sync, seed outbox with all existing data so cloud gets everything
    await seedFullSnapshotIfNeeded(restaurant.id, billingUserId, branchId)
    await ensureEssentialSyncIdentityRows(restaurant.id)

    const unsyncedSummaries = await prisma.dailySummary.findMany({
      where: { userId: billingUserId, restaurantId: restaurant.id, ...(branchId ? { branchId } : {}), synced: false },
      orderBy: { date: 'asc' },
    })

    const pendingOutboxBranchId = syncUser.role === 'admin' ? undefined : branchId

    const [restaurantCursor, globalCursor, pendingOutboxRows] = await Promise.all([
      getSyncCursor(prisma, { scopeId: restaurant.id, restaurantId: restaurant.id }),
      getSyncCursor(prisma, { scopeId: GLOBAL_SYNC_SCOPE_ID, restaurantId: restaurant.id }),
      // 100 entries per cycle — was 30, which caused multi-cycle backlogs on first sync
    listPrioritizedPendingSyncOutboxChanges(restaurant.id, pendingOutboxBranchId, 100),
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

    activeBatch = {
      restaurantId: restaurant.id,
      batchId,
      payloadHash,
    }
    await upsertLocalSyncBatch(restaurant.id, batchId, payloadHash, {
      status: 'processing',
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
        branchIdentity,
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

        await upsertLocalSyncBatch(restaurant.id, batchId, payloadHash, {
          status: 'failed',
          errorMessage: 'Branch identity refreshed from cloud. Retry sync to continue.',
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
      await upsertLocalSyncBatch(restaurant.id, batchId, payloadHash, {
        status: 'failed',
        errorMessage: payload?.error || 'Sync failed',
      })
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
      await upsertLocalSyncBatch(restaurant.id, batchId, payloadHash, {
        status: 'failed',
        errorMessage: 'Cloud sync batch acknowledgement mismatch',
      })
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

    // ATOMIC: all three acknowledgment writes must succeed or all must fail.
    // A crash between any two previously separate calls left the DB in a split state
    // where some records were marked synced but outbox rows were not (or vice versa),
    // causing infinite re-sends that the cloud rejected as duplicate batchIds.
    await prisma.$transaction(async (ackTx) => {
      if (syncedIds.length > 0) {
        await ackTx.transaction.updateMany({
          where: { id: { in: syncedIds } },
          data: { synced: true },
        })
      }
      if (unsyncedSummaries.length > 0) {
        await ackTx.dailySummary.updateMany({
          where: { id: { in: unsyncedSummaries.map((row) => row.id) } },
          data: { synced: true },
        })
      }
      if (pendingOutboxRows.length > 0) {
        await ackTx.syncOutbox.updateMany({
          where: { id: { in: pendingOutboxRows.map((row) => row.id) } },
          data: { syncedAt: new Date(), claimedAt: null, lastError: null },
        })
      }
    })

    // Reset any exhausted outbox entries so they get retried on the next sync cycle
    await resetSyncOutboxRowsForRetry(prisma, {
      scopeIds: [restaurant.id, GLOBAL_SYNC_SCOPE_ID],
      branchId,
      onlyExhausted: true,
    })

    const rawPullChanges = Array.isArray(payload?.pullChanges)
      ? payload.pullChanges
      : []
    const pullCursors = Array.isArray(payload?.pullCursors) ? payload.pullCursors : []
    let appliedChanges = 0
    let conflictCount = 0
    let appliedPulledChanges: SyncChangeEnvelope[] = []

    if (rawPullChanges.length > 0) {
      remapPulledRestaurantScopeChanges(rawPullChanges, restaurant.id)
      await remapPulledBranchIds(rawPullChanges, restaurant.id, branchId)
    }

    const pulledChanges = rawPullChanges.filter((change: any) => isBranchVisibleChange(change, branchId))

    if (rawPullChanges.length > 0 && pulledChanges.length === 0) {
      logSyncActivity('warn', 'sync.local.pull_changes_filtered_all', {
        restaurantId: restaurant.id,
        restaurantSyncId: restaurant.syncRestaurantId,
        deviceId,
        batchId,
        rawPullChanges: rawPullChanges.length,
        branchId,
      })
    }

    await prisma.$transaction(async (tx) => {
      if (pulledChanges.length > 0) {
        const appliedResult = await applyIncomingSyncChanges(tx, pulledChanges, {
          localDeviceId: deviceId,
          remapUserId: billingUserId,
        })
        appliedChanges = appliedResult.applied
        conflictCount = appliedResult.conflicts
        appliedPulledChanges = appliedResult.appliedChanges
      }

      for (const cursor of pullCursors) {
        const scopeId = String(cursor.scopeId)
        const scopedAppliedChanges = appliedPulledChanges.filter((change) => {
          const changeScopeId = String(change.scopeId ?? '').trim()
          if (scopeId === GLOBAL_SYNC_SCOPE_ID) return changeScopeId === GLOBAL_SYNC_SCOPE_ID
          return changeScopeId !== GLOBAL_SYNC_SCOPE_ID
        })

        await updateSyncCursor(tx, {
          scopeId,
          restaurantId: restaurant.id,
          ...(scopedAppliedChanges.length > 0
            ? {
                lastPulledAt: latestSyncChangeTimestamp(scopedAppliedChanges),
                lastMutationId: latestSyncMutationId(scopedAppliedChanges),
              }
            : {}),
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
    const pushedTransactionCount = Number(payload?.transactions ?? transactions.length)
    const pushedSummaryCount = Number(payload?.summaries ?? summaries.length)
    const pulledTransactionCount = appliedPulledChanges.filter((change) => change.entityType === 'transaction').length
    const syncedTransactionCount = pushedTransactionCount + pulledTransactionCount
    const syncMessage = payload?.message || (noOutboundChanges && noPulledChanges
      ? 'No local or remote changes to sync'
      : 'Owner cloud sync completed successfully')

    await upsertLocalSyncBatch(restaurant.id, batchId, payloadHash, {
      status: 'success',
      errorMessage: null,
      syncedTransactions: syncedTransactionCount,
      syncedSummaries: pushedSummaryCount,
      appliedAt: new Date(),
    })

    await markSyncSuccess(restaurant.id, {
      transactions: syncedTransactionCount,
      summaries: pushedSummaryCount,
    }, syncMessage)

    logSyncActivity(conflictCount > 0 ? 'warn' : 'info', 'sync.local.completed', {
      restaurantId: restaurant.id,
      restaurantSyncId: restaurant.syncRestaurantId,
      deviceId,
      batchId,
      syncedTransactions: syncedTransactionCount,
      syncedSummaries: pushedSummaryCount,
      pushedTransactions: pushedTransactionCount,
      pulledTransactionChanges: pulledTransactionCount,
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
      syncedTransactions: syncedTransactionCount,
      syncedSummaries: pushedSummaryCount,
      pushedTransactions: pushedTransactionCount,
      pulledTransactionChanges: pulledTransactionCount,
      pushedChanges: Number(payload?.changes ?? changes.length),
      pulledChanges: pulledChanges.length,
      appliedChanges,
      conflictCount,
    })
  } catch (error) {
    if (activeBatch) {
      await upsertLocalSyncBatch(activeBatch.restaurantId, activeBatch.batchId, activeBatch.payloadHash, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Sync failed',
      }).catch(() => null)
    }
    const message = error instanceof Error ? error.message : 'Sync failed'
    const userId = await getServerSession(authOptions).then((session) => session?.user?.id).catch(() => null)
    let restaurantId: string | null = null
    if (userId) {
      const context = await getRestaurantContextForUser(userId).catch(() => null)
      let restaurant: { id: string } | null = context?.restaurant ?? null
      if (!restaurant && canAutoCreateRestaurantContext()) {
        const userExists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }).catch(() => null)
        if (userExists) {
          restaurant = await ensureRestaurantForOwner(userId).catch(() => null)
        }
      }
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
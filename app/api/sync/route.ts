import { NextResponse } from 'next/server'
import { compare } from 'bcryptjs'
import { timingSafeEqual } from 'crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { resolveRestaurantForSyncUser } from '@/lib/restaurantAccess'
import type { SyncSummaryPayload, SyncTransactionPayload } from '@/lib/minimalSync'
import { applyIncomingSyncChanges, recordRemoteChangeForPull } from '@/lib/syncEngine'
import { logSyncActivity } from '@/lib/syncLogging'
import { CLOUD_SYNC_TARGET, BRANCH_REQUIRED_ENTITY_TYPES, GLOBAL_SYNC_SCOPE_ID, isRestaurantWideSyncEntity, latestSyncChangeTimestamp, latestSyncMutationId, mapSyncOutboxRows, type SyncChangeEnvelope } from '@/lib/syncOutbox'
import { createRateLimiter, getRateLimitKey } from '@/lib/rateLimit'

// 30 sync requests per device per minute is generous for normal usage.
const syncLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })

// Vercel Pro: 60s max. Hobby: 10s max (sync will time out on large batches on Hobby).
// If still on Hobby, reduce ENTITY_ORDER batch count and use pgbouncer in DATABASE_URL.
export const maxDuration = 60

type PrismaDb = PrismaClient | Prisma.TransactionClient

type BranchLookupRecord = {
  id: string
  name: string
  code: string
  isMain: boolean
  isActive: boolean
}

type CloudBranchContext = {
  branchIdRemap: Map<string, string>
  existingBranchIds: Set<string>
  resolvedBranchId: string | null
}

type RequestedBranchIdentity = {
  id: string | null
  code: string
  name: string
  isMain: boolean
}

// S3: Derived from BRANCH_REQUIRED_ENTITY_TYPES in syncOutbox — single source of truth.
const REQUIRED_BRANCH_SYNC_ENTITY_TYPES = BRANCH_REQUIRED_ENTITY_TYPES

function matchesSharedSecret(input: string, expected: string) {
  if (!input || !expected) return false
  const a = Buffer.from(input)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function normalizeSyncBranchValue(value: unknown) {
  return String(value ?? '').trim()
}

function remapIncomingBranchId(
  value: unknown,
  branchIdRemap: Map<string, string>,
  existingBranchIds: Set<string>,
  fallbackBranchId: string | null,
) {
  const normalized = normalizeSyncBranchValue(value)
  if (!normalized) return fallbackBranchId

  const mappedBranchId = branchIdRemap.get(normalized)
  if (mappedBranchId) return mappedBranchId
  if (existingBranchIds.has(normalized)) return normalized
  return fallbackBranchId ?? normalized
}

function ensureKnownBranchId(
  change: SyncChangeEnvelope,
  existingBranchIds: Set<string>,
  payload?: Record<string, unknown>,
) {
  if (!REQUIRED_BRANCH_SYNC_ENTITY_TYPES.has(change.entityType)) return

  const normalizedBranchId = normalizeSyncBranchValue(change.branchId ?? payload?.branchId)
  if (!normalizedBranchId) {
    throw new Error(`Sync change ${change.entityType}:${change.entityId} is missing a resolved branchId`)
  }

  if (!existingBranchIds.has(normalizedBranchId)) {
    throw new Error(`Sync change ${change.entityType}:${change.entityId} resolved to unknown branch ${normalizedBranchId}`)
  }
}

async function resolveCloudBranchContext(
  db: PrismaDb,
  restaurantId: string,
  requestedBranchId: string | null,
  requestedBranchIdentity: RequestedBranchIdentity | null,
  changes: SyncChangeEnvelope[],
): Promise<CloudBranchContext> {
  const existingBranches = await db.restaurantBranch.findMany({
    where: { restaurantId },
    select: { id: true, name: true, code: true, isMain: true, isActive: true },
    orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  }) as BranchLookupRecord[]

  const branchIdRemap = new Map<string, string>()

  for (const change of changes) {
    if (change.entityType !== 'restaurantBranch' || change.operation === 'delete') continue

    const payload = (change.payload ?? {}) as Record<string, unknown>
    const localBranchId = normalizeSyncBranchValue(payload.id ?? change.entityId)
    if (!localBranchId) continue

    const branchCode = normalizeSyncBranchValue(payload.code)
    const branchName = normalizeSyncBranchValue(payload.name)
    const isMain = Boolean(payload.isMain)

    const existingBranch = existingBranches.find((branch) => branchCode && branch.code === branchCode)
      ?? existingBranches.find((branch) => branchName && branch.name === branchName)
      ?? (isMain ? existingBranches.find((branch) => branch.isMain) : undefined)

    if (existingBranch) {
      branchIdRemap.set(localBranchId, existingBranch.id)
    }
  }

  const activeBranches = existingBranches.filter((branch) => branch.isActive)
  const loneActiveMainBranch = activeBranches.length === 1 && activeBranches[0]?.isMain
    ? activeBranches[0]
    : null

  const hintedBranch = requestedBranchIdentity
    ? existingBranches.find((branch) => requestedBranchIdentity.code && branch.code === requestedBranchIdentity.code)
      ?? existingBranches.find((branch) => requestedBranchIdentity.name && branch.name === requestedBranchIdentity.name)
      ?? (requestedBranchIdentity.isMain ? existingBranches.find((branch) => branch.isMain) : undefined)
    : undefined

  if (requestedBranchId && hintedBranch) {
    branchIdRemap.set(requestedBranchId, hintedBranch.id)
  }

  return {
    branchIdRemap,
    existingBranchIds: new Set(existingBranches.map((branch) => branch.id)),
    resolvedBranchId: requestedBranchId
      ? branchIdRemap.get(requestedBranchId) ?? hintedBranch?.id ?? loneActiveMainBranch?.id ?? requestedBranchId
      : null,
  }
}

async function ensureSyncAccounts(db: PrismaDb, restaurantId: string, syncRestaurantId: string) {
  // Use upsert (not findFirst+create) to avoid unique-constraint races when sync retries quickly.
  const incomeCategory = await db.category.upsert({
    where: { restaurantId_name: { restaurantId, name: 'Synced Sales Revenue' } },
    create: { restaurantId, name: 'Synced Sales Revenue', type: 'income', description: 'Cloud-synced local restaurant sales' },
    update: {},
  })

  const expenseCategory = await db.category.upsert({
    where: { restaurantId_name: { restaurantId, name: 'Synced Operating Expense' } },
    create: { restaurantId, name: 'Synced Operating Expense', type: 'expense', description: 'Cloud-synced local restaurant expenses' },
    update: {},
  })

  const codeSuffix = syncRestaurantId.slice(-8).toUpperCase()

  let incomeAccount = await db.account.findFirst({ where: { restaurantId, name: 'Synced Sales' } })
  if (!incomeAccount) {
    incomeAccount = await db.account.create({
      data: {
        restaurantId,
        code: `SYNC-SALE-${codeSuffix}`,
        name: 'Synced Sales',
        categoryId: incomeCategory.id,
        type: 'revenue',
        description: 'Sales synced from local restaurant database',
      },
    })
  }

  let expenseAccount = await db.account.findFirst({ where: { restaurantId, name: 'Synced Expenses' } })
  if (!expenseAccount) {
    expenseAccount = await db.account.create({
      data: {
        restaurantId,
        code: `SYNC-EXP-${codeSuffix}`,
        name: 'Synced Expenses',
        categoryId: expenseCategory.id,
        type: 'expense',
        description: 'Expenses synced from local restaurant database',
      },
    })
  }

  return { incomeCategory, expenseCategory, incomeAccount, expenseAccount }
}

async function collectPullChanges(db: PrismaDb, params: { restaurantId: string; branchId?: string | null; deviceId?: string | null; pullCursors?: Array<{ scopeId?: string; lastPulledAt?: string | null; lastMutationId?: string | null }> }) {
  const cursorInputs = Array.isArray(params.pullCursors) && params.pullCursors.length > 0
    ? params.pullCursors
    : [
        { scopeId: params.restaurantId, lastPulledAt: null, lastMutationId: null },
        { scopeId: GLOBAL_SYNC_SCOPE_ID, lastPulledAt: null, lastMutationId: null },
      ]

  const normalizedCursorInputs = cursorInputs
    .map((cursor) => {
      const originalScopeId = String(cursor.scopeId || '').trim()
      if (!originalScopeId) return null

      // Desktop/local devices track restaurant-scoped cursors using their local SQLite
      // restaurant id, but cloud outbox rows are scoped by the resolved cloud restaurant id.
      // Normalize non-global cursor scope ids for querying while preserving the caller's
      // original scope id in the response so local cursor rows stay stable.
      const queryScopeId = originalScopeId === GLOBAL_SYNC_SCOPE_ID
        ? GLOBAL_SYNC_SCOPE_ID
        : params.restaurantId

      return {
        originalScopeId,
        queryScopeId,
        lastPulledAt: cursor.lastPulledAt ?? null,
        lastMutationId: cursor.lastMutationId ?? null,
      }
    })
    .filter(Boolean) as Array<{
      originalScopeId: string
      queryScopeId: string
      lastPulledAt: string | null
      lastMutationId: string | null
    }>

  const whereClauses = normalizedCursorInputs
    .map((cursor) => {
      return {
        scopeId: cursor.queryScopeId,
        ...(cursor.lastPulledAt ? { createdAt: { gt: new Date(String(cursor.lastPulledAt)) } } : {}),
      }
    })
    .filter(Boolean) as Array<Record<string, unknown>>

  const rows = whereClauses.length > 0
    ? await db.syncOutbox.findMany({
        where: {
          OR: whereClauses as any,
          ...(params.branchId !== undefined
            ? {
                AND: [
                  {
                    OR: [
                      { scopeId: GLOBAL_SYNC_SCOPE_ID },
                      { entityType: 'restaurant' },
                      { entityType: 'restaurantBranch' },
                      { branchId: params.branchId ?? null },
                    ],
                  },
                ],
              }
            : {}),
          ...(params.deviceId && params.deviceId !== CLOUD_SYNC_TARGET ? { NOT: { sourceDeviceId: params.deviceId } } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 500,
      })
    : []

  const pullChanges = mapSyncOutboxRows(rows)
  const pullCursors = normalizedCursorInputs.map((cursor) => {
    const scopedChanges = pullChanges.filter((change) => change.scopeId === cursor.queryScopeId)
    return {
      scopeId: cursor.originalScopeId,
      lastPulledAt: latestSyncChangeTimestamp(scopedChanges)?.toISOString() ?? cursor.lastPulledAt ?? null,
      lastMutationId: latestSyncMutationId(scopedChanges) ?? cursor.lastMutationId ?? null,
    }
  })

  return { pullChanges, pullCursors }
}

export async function POST(req: Request) {
  const rlResult = syncLimiter.check(getRateLimitKey(req, 'sync'))
  if (!rlResult.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, {
      status: 429,
      headers: { 'Retry-After': String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)) },
    })
  }

  let parsedBody: any = null

  try {
    const email = req.headers.get('x-sync-email')?.trim().toLowerCase() ?? ''
    const sharedSecret = req.headers.get('x-sync-secret')?.trim() ?? ''
    const password = req.headers.get('x-sync-password') ?? ''
    const configuredOwnerEmail = String(process.env.OWNER_SYNC_EMAIL ?? '').trim().toLowerCase()
    if (!email || (!sharedSecret && !password)) {
      return NextResponse.json({ error: 'Sync credentials are required' }, { status: 401 })
    }

    parsedBody = await req.json()

    const configuredSharedSecret = process.env.OWNER_SYNC_SHARED_SECRET?.trim() ?? ''
    let user = await prisma.user.findUnique({ where: { email } })

    if (!user && sharedSecret && matchesSharedSecret(sharedSecret, configuredSharedSecret)) {
      // Auto-provision user from trusted desktop sync (shared secret proves legitimacy)
      const provision = parsedBody.provisionUser
      // Resolve the restaurant at provisioning time so the new user is immediately linked
      const provisionSyncRestaurantId = String(parsedBody.restaurantSyncId ?? '').trim()
      const provisionRestaurant = provisionSyncRestaurantId
        ? await prisma.restaurant.findFirst({ where: { syncRestaurantId: provisionSyncRestaurantId }, select: { id: true, branches: { where: { isMain: true }, select: { id: true }, take: 1 } } })
        : null
      user = await prisma.user.create({
        data: {
          email,
          name: typeof provision?.name === 'string' && provision.name ? provision.name : email,
          password: typeof provision?.passwordHash === 'string' && provision.passwordHash ? provision.passwordHash : '',
          role: typeof provision?.role === 'string' && provision.role ? provision.role : 'admin',
          ...(provisionRestaurant ? { restaurantId: provisionRestaurant.id, branchId: provisionRestaurant.branches[0]?.id ?? null } : {}),
        },
      })
      logSyncActivity('info', 'sync.cloud.user_auto_provisioned', { email, userId: user.id, linkedRestaurantId: provisionRestaurant?.id ?? null })
    }

    if (!user) return NextResponse.json({ error: 'Invalid sync credentials' }, { status: 401 })

    if (sharedSecret) {
      if (!matchesSharedSecret(sharedSecret, configuredSharedSecret)) {
        return NextResponse.json({ error: 'Invalid sync credentials' }, { status: 401 })
      }
    } else {
      const passwordOk = await compare(password, user.password)
      if (!passwordOk) return NextResponse.json({ error: 'Invalid sync credentials' }, { status: 401 })
    }
    const restaurantSyncId = String(parsedBody.restaurantSyncId ?? '').trim()
    const restaurantName = String(parsedBody.restaurantName ?? '').trim()
    const restaurantToken = String(parsedBody.restaurantToken ?? '')
    const branchId = String(parsedBody.branchId ?? '').trim() || null
    const branchIdentity = parsedBody.branchIdentity && typeof parsedBody.branchIdentity === 'object'
      ? {
          id: typeof parsedBody.branchIdentity.id === 'string' ? parsedBody.branchIdentity.id.trim() || null : null,
          code: typeof parsedBody.branchIdentity.code === 'string' ? parsedBody.branchIdentity.code.trim() : '',
          name: typeof parsedBody.branchIdentity.name === 'string' ? parsedBody.branchIdentity.name.trim() : '',
          isMain: Boolean(parsedBody.branchIdentity.isMain),
        }
      : null
    const batchId = String(parsedBody.batchId ?? '').trim()
    const payloadHash = String(parsedBody.payloadHash ?? '').trim()
    const deviceId = String(parsedBody.deviceId ?? '').trim() || null
    const transactions = (Array.isArray(parsedBody.transactions) ? parsedBody.transactions : []) as SyncTransactionPayload[]
    const summaries = (Array.isArray(parsedBody.summaries) ? parsedBody.summaries : []) as SyncSummaryPayload[]
    const changes = (Array.isArray(parsedBody.changes) ? parsedBody.changes : []) as SyncChangeEnvelope[]
    const pullCursors = Array.isArray(parsedBody.pullCursors) ? parsedBody.pullCursors : []

    if (!restaurantSyncId || !restaurantToken || !batchId || !payloadHash) {
      return NextResponse.json({ error: 'restaurantSyncId, restaurantToken, batchId, and payloadHash are required' }, { status: 400 })
    }

    const resolvedRestaurant = await resolveRestaurantForSyncUser({
      id: user.id,
      role: user.role,
      restaurantId: user.restaurantId ?? null,
    }, {
      restaurantSyncId,
      restaurantToken,
      restaurantName,
    }, {
      allowOwnerTransfer: Boolean(sharedSecret && configuredOwnerEmail && email === configuredOwnerEmail),
    })
    if (!resolvedRestaurant.ok) {
      return NextResponse.json({
        error: resolvedRestaurant.error,
        ...(resolvedRestaurant.linkedRestaurant ? { linkedRestaurant: resolvedRestaurant.linkedRestaurant } : {}),
      }, { status: resolvedRestaurant.status })
    }
    const restaurant = resolvedRestaurant.restaurant
    const branchContext = await resolveCloudBranchContext(prisma, restaurant.id, branchId, branchIdentity, changes)
    const resolvedBranchId = branchContext.resolvedBranchId

    const existingBatch = await prisma.restaurantSyncBatch.findUnique({
      where: {
        restaurantId_batchId: {
          restaurantId: restaurant.id,
          batchId,
        },
      },
    })

    if (existingBatch?.payloadHash && existingBatch.payloadHash !== payloadHash) {
      return NextResponse.json({ error: 'Conflicting sync batch payload for this branch batch id' }, { status: 409 })
    }

    if (existingBatch?.status === 'success') {
      const pull = await collectPullChanges(prisma, { restaurantId: restaurant.id, branchId: resolvedBranchId, deviceId, pullCursors })
      logSyncActivity('info', 'sync.cloud.duplicate_acknowledged', {
        restaurantId: restaurant.id,
        restaurantSyncId,
        deviceId,
        batchId,
      })
      return NextResponse.json({
        ok: true,
        duplicate: true,
        batchId,
        message: 'Sync batch already applied; replay acknowledged safely.',
        transactions: existingBatch.syncedTransactions,
        summaries: existingBatch.syncedSummaries,
        changes: changes.length,
        pullChanges: pull.pullChanges,
        pullCursors: pull.pullCursors,
      })
    }

    logSyncActivity('info', 'sync.cloud.started', {
      restaurantId: restaurant.id,
      restaurantSyncId,
      deviceId,
      batchId,
      transactions: transactions.length,
      summaries: summaries.length,
      changes: changes.length,
    })

    // Increase timeout to 60s — large batches with 100+ entity upserts need more than the 5s default
    const result = await prisma.$transaction(async (tx) => {
      await tx.restaurantSyncBatch.upsert({
        where: {
          restaurantId_batchId: {
            restaurantId: restaurant.id,
            batchId,
          },
        },
        create: {
          restaurantId: restaurant.id,
          batchId,
          payloadHash,
          status: 'processing',
        },
        update: {
          payloadHash,
          status: 'processing',
          errorMessage: null,
          syncedTransactions: 0,
          syncedSummaries: 0,
        },
      })

      // S-ENTITY_ORDER: This map must stay in sync with RESTAURANT_WIDE_ENTITY_TYPES and
      // BRANCH_REQUIRED_ENTITY_TYPES in lib/syncOutbox.ts. When adding a new entity type:
      // 1. Add it to the correct set in syncOutbox.ts
      // 2. Add a case in lib/syncEngine.ts applyResolvedSyncChange
      // 3. Add it here with the correct dependency order (parent before child)
      // Unknown types fall through to ENTITY_ORDER ?? 99 (sorted last) and then hit
      // the M1 throw in the switch default — they will NOT be silently dropped.
      const ENTITY_ORDER: Record<string, number> = {
        restaurant: 0,
        restaurantBranch: 1,
        pricingPlan: 2,
        restaurantTable: 3,
        dish: 4,
        inventoryItem: 5,
        employee: 6,
        dishIngredient: 7,
        inventoryPurchase: 8,
        inventoryAdjustmentLog: 9,
        inventoryBatchUsageLedger: 10,
        dishSale: 11,
        wasteLog: 12,
        shift: 13,
        restaurantOrder: 14,
        transaction: 15,
      }
      const sortedChanges = [...changes].sort(
        (a, b) => (ENTITY_ORDER[a.entityType] ?? 99) - (ENTITY_ORDER[b.entityType] ?? 99),
      )

      for (const change of sortedChanges) {
        const p = change.payload as Record<string, any> | undefined
        change.restaurantId = change.scopeId === GLOBAL_SYNC_SCOPE_ID ? null : restaurant.id

        if (p && typeof p.restaurantId === 'string' && p.restaurantId !== restaurant.id) {
          p.restaurantId = restaurant.id
        }

        if (change.entityType === 'restaurantBranch') {
          const mappedBranchId = branchContext.branchIdRemap.get(normalizeSyncBranchValue(p?.id ?? change.entityId))
          if (mappedBranchId) {
            change.entityId = mappedBranchId
            if (p) p.id = mappedBranchId
          }
        }

        if (isRestaurantWideSyncEntity(change.entityType)) {
          change.branchId = null
        } else if (change.scopeId !== GLOBAL_SYNC_SCOPE_ID) {
          const mappedBranchId = remapIncomingBranchId(
            change.branchId ?? p?.branchId,
            branchContext.branchIdRemap,
            branchContext.existingBranchIds,
            resolvedBranchId,
          )
          change.branchId = mappedBranchId
          if (p && (p.branchId != null || mappedBranchId != null)) {
            p.branchId = mappedBranchId
          }
        }

        ensureKnownBranchId(change, branchContext.existingBranchIds, p)

        if (change.entityType === 'restaurant') {
          change.entityId = restaurant.id
          if (p) p.id = restaurant.id
        }
      }

      const { incomeCategory, expenseCategory, incomeAccount, expenseAccount } = await ensureSyncAccounts(tx, restaurant.id, restaurantSyncId)

      const billingUserId = restaurant.ownerId

      for (const row of transactions) {
        await tx.transaction.upsert({
          where: { id: row.id },
          update: {
            userId: billingUserId,
            restaurantId: restaurant.id,
            branchId: resolvedBranchId,
            accountId: row.type === 'sale' ? incomeAccount.id : expenseAccount.id,
            categoryId: row.type === 'sale' ? incomeCategory.id : expenseCategory.id,
            date: new Date(row.createdAt),
            description: row.description,
            amount: row.amount,
            type: row.type === 'sale' ? 'credit' : 'debit',
            paymentMethod: row.paymentMethod || 'Synced',
            accountName: row.accountName,
            isManual: row.isManual ?? true,
            sourceKind: row.sourceKind || 'cloud_sync',
            authoritativeForRevenue: true,
            synced: true,
          },
          create: {
            id: row.id,
            userId: billingUserId,
            restaurantId: restaurant.id,
            branchId: resolvedBranchId,
            accountId: row.type === 'sale' ? incomeAccount.id : expenseAccount.id,
            categoryId: row.type === 'sale' ? incomeCategory.id : expenseCategory.id,
            date: new Date(row.createdAt),
            description: row.description,
            amount: row.amount,
            type: row.type === 'sale' ? 'credit' : 'debit',
            paymentMethod: row.paymentMethod || 'Synced',
            accountName: row.accountName,
            isManual: row.isManual ?? true,
            sourceKind: row.sourceKind || 'cloud_sync',
            authoritativeForRevenue: true,
            synced: true,
          },
        })
      }

      for (const row of summaries) {
        await tx.dailySummary.upsert({
          where: { id: row.id },
          update: {
            userId: billingUserId,
            restaurantId: restaurant.id,
            branchId: resolvedBranchId,
            date: new Date(String(row.date).split('T')[0] + 'T12:00:00Z'),
            totalRevenue: row.totalRevenue,
            totalExpenses: row.totalExpenses,
            profitLoss: row.profitLoss,
            lastUpdated: new Date(row.lastUpdated),
            synced: true,
          },
          create: {
            id: row.id,
            userId: billingUserId,
            restaurantId: restaurant.id,
            branchId: resolvedBranchId,
            date: new Date(String(row.date).split('T')[0] + 'T12:00:00Z'),
            totalRevenue: row.totalRevenue,
            totalExpenses: row.totalExpenses,
            profitLoss: row.profitLoss,
            lastUpdated: new Date(row.lastUpdated),
            synced: true,
          },
        })
      }

      const appliedEntityChanges = await applyIncomingSyncChanges(tx, sortedChanges, { localDeviceId: 'cloud', remapUserId: billingUserId })
      // C2: Log per-entity failures without aborting the batch transaction.
      // Also persist each failure to RestaurantSyncEvent so the admin sync-health panel can surface them.
      for (const { change: failedChange, error: failedError } of appliedEntityChanges.failedChanges ?? []) {
        logSyncActivity('warn', 'sync.cloud.entity_apply_failed', {
          restaurantId: restaurant.id,
          entityType: failedChange.entityType,
          entityId: failedChange.entityId,
          error: failedError,
        })
        await tx.restaurantSyncEvent.create({
          data: {
            restaurantId: restaurant.id,
            status: 'entity_apply_failed',
            message: `[${failedChange.entityType}] ${failedChange.entityId}: ${failedError}`,
            syncedTransactions: 0,
            syncedSummaries: 0,
            consecutiveFailures: 1,
          },
        })
      }
      for (const change of appliedEntityChanges.appliedChanges) {
        await recordRemoteChangeForPull(tx, {
          ...change,
          restaurantId: change.scopeId === GLOBAL_SYNC_SCOPE_ID ? null : restaurant.id,
          branchId: change.scopeId === GLOBAL_SYNC_SCOPE_ID || isRestaurantWideSyncEntity(change.entityType)
            ? null
            : (change.branchId ?? resolvedBranchId),
          payload: change.payload && typeof change.payload === 'object'
            ? {
                ...(change.payload as Record<string, unknown>),
                ...(change.scopeId === GLOBAL_SYNC_SCOPE_ID
                  ? {}
                  : {
                      restaurantId: restaurant.id,
                      ...(!isRestaurantWideSyncEntity(change.entityType) && resolvedBranchId ? { branchId: change.branchId ?? resolvedBranchId } : {}),
                    }),
              }
            : change.payload,
        })
      }

      const pull = await collectPullChanges(tx, { restaurantId: restaurant.id, branchId: resolvedBranchId, deviceId, pullCursors })

      await tx.restaurantSyncBatch.update({
        where: {
          restaurantId_batchId: {
            restaurantId: restaurant.id,
            batchId,
          },
        },
        data: {
          status: 'success',
          errorMessage: null,
          syncedTransactions: transactions.length,
          syncedSummaries: summaries.length,
          appliedAt: new Date(),
        },
      })

      return {
        ok: true,
        batchId,
        message: pull.pullChanges.length > 0 || appliedEntityChanges.applied > 0 || transactions.length > 0 || summaries.length > 0
          ? 'Sync batch applied successfully.'
          : 'No local or remote changes to sync.',
        transactions: transactions.length,
        summaries: summaries.length,
        changes: appliedEntityChanges.applied,
        conflicts: appliedEntityChanges.conflicts,
        pullChanges: pull.pullChanges,
        pullCursors: pull.pullCursors,
      }
    }, { timeout: 55000 })

    if (result.transactions === 0 && result.summaries === 0) {
      console.warn('[SYNC] WARNING: batch processed but 0 financial records written', { batchId, restaurantId: restaurant.id, changes: result.changes })
    } else {
      console.log('[SYNC] batchId:', batchId, 'transactions:', result.transactions, 'summaries:', result.summaries)
    }

    logSyncActivity(result.conflicts > 0 ? 'warn' : 'info', 'sync.cloud.completed', {
      restaurantId: restaurant.id,
      restaurantSyncId,
      deviceId,
      batchId,
      transactions: result.transactions,
      summaries: result.summaries,
      changes: result.changes,
      conflicts: result.conflicts,
      pullChanges: result.pullChanges.length,
    })

    return NextResponse.json(result)
  } catch (error) {
    try {
      const restaurantSyncId = String(parsedBody?.restaurantSyncId ?? '').trim()
      const batchId = String(parsedBody?.batchId ?? '').trim()
      const payloadHash = String(parsedBody?.payloadHash ?? '').trim()
      if (restaurantSyncId && batchId && payloadHash) {
        const restaurant = await prisma.restaurant.findUnique({ where: { syncRestaurantId: restaurantSyncId }, select: { id: true } })
        if (restaurant) {
          await prisma.restaurantSyncBatch.upsert({
            where: {
              restaurantId_batchId: {
                restaurantId: restaurant.id,
                batchId,
              },
            },
            create: {
              restaurantId: restaurant.id,
              batchId,
              payloadHash,
              status: 'failed',
              errorMessage: error instanceof Error ? error.message : 'Failed to sync records',
            },
            update: {
              payloadHash,
              status: 'failed',
              errorMessage: error instanceof Error ? error.message : 'Failed to sync records',
            },
          })
        }
      }
    } catch {
      // Best-effort failure capture only.
    }

    logSyncActivity('error', 'sync.cloud.failed', {
      restaurantSyncId: String(parsedBody?.restaurantSyncId ?? '').trim() || null,
      deviceId: String(parsedBody?.deviceId ?? '').trim() || null,
      batchId: String(parsedBody?.batchId ?? '').trim() || null,
      error: error instanceof Error ? error.message : 'Failed to sync records',
    })

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync records' },
      { status: 500 }
    )
  }
}
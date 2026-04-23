import { NextResponse } from 'next/server'
import { compare } from 'bcryptjs'
import { timingSafeEqual } from 'crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { resolveRestaurantForSyncUser } from '@/lib/restaurantAccess'
import type { SyncSummaryPayload, SyncTransactionPayload } from '@/lib/minimalSync'
import { applyIncomingSyncChanges, recordRemoteChangeForPull } from '@/lib/syncEngine'
import { logSyncActivity } from '@/lib/syncLogging'
import { GLOBAL_SYNC_SCOPE_ID, isRestaurantWideSyncEntity, latestSyncChangeTimestamp, latestSyncMutationId, mapSyncOutboxRows, type SyncChangeEnvelope } from '@/lib/syncOutbox'

// Allow up to 10s on Vercel Hobby; batching keeps payload small enough
export const maxDuration = 10

type PrismaDb = PrismaClient | Prisma.TransactionClient

function matchesSharedSecret(input: string, expected: string) {
  if (!input || !expected) return false
  const a = Buffer.from(input)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function ensureSyncAccounts(db: PrismaDb, restaurantId: string, syncRestaurantId: string) {
  let incomeCategory = await db.category.findFirst({ where: { restaurantId, name: 'Synced Sales Revenue' } })
  if (!incomeCategory) {
    incomeCategory = await db.category.create({
      data: { restaurantId, name: 'Synced Sales Revenue', type: 'income', description: 'Cloud-synced local restaurant sales' },
    })
  }

  let expenseCategory = await db.category.findFirst({ where: { restaurantId, name: 'Synced Operating Expense' } })
  if (!expenseCategory) {
    expenseCategory = await db.category.create({
      data: { restaurantId, name: 'Synced Operating Expense', type: 'expense', description: 'Cloud-synced local restaurant expenses' },
    })
  }

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

  const whereClauses = cursorInputs
    .map((cursor) => {
      const scopeId = String(cursor.scopeId || '').trim()
      if (!scopeId) return null
      return {
        scopeId,
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
          ...(params.deviceId ? { NOT: { sourceDeviceId: params.deviceId } } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 500,
      })
    : []

  const pullChanges = mapSyncOutboxRows(rows)
  const pullCursors = cursorInputs.map((cursor) => {
    const scopeId = String(cursor.scopeId || '').trim()
    const scopedChanges = pullChanges.filter((change) => change.scopeId === scopeId)
    return {
      scopeId,
      lastPulledAt: latestSyncChangeTimestamp(scopedChanges)?.toISOString() ?? cursor.lastPulledAt ?? null,
      lastMutationId: latestSyncMutationId(scopedChanges) ?? cursor.lastMutationId ?? null,
    }
  })

  return { pullChanges, pullCursors }
}

export async function POST(req: Request) {
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
      user = await prisma.user.create({
        data: {
          email,
          name: typeof provision?.name === 'string' && provision.name ? provision.name : email,
          password: typeof provision?.passwordHash === 'string' && provision.passwordHash ? provision.passwordHash : '',
          role: typeof provision?.role === 'string' && provision.role ? provision.role : 'admin',
        },
      })
      logSyncActivity('info', 'sync.cloud.user_auto_provisioned', { email, userId: user.id })
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
      const pull = await collectPullChanges(prisma, { restaurantId: restaurant.id, branchId, deviceId, pullCursors })
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

      const { incomeCategory, expenseCategory, incomeAccount, expenseAccount } = await ensureSyncAccounts(tx, restaurant.id, restaurantSyncId)

      for (const row of transactions) {
        await tx.transaction.upsert({
          where: { id: row.id },
          update: {
            userId: user.id,
            restaurantId: restaurant.id,
            branchId,
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
            userId: user.id,
            restaurantId: restaurant.id,
            branchId,
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
            userId: user.id,
            restaurantId: restaurant.id,
            branchId,
            date: new Date(String(row.date).split('T')[0] + 'T12:00:00Z'),
            totalRevenue: row.totalRevenue,
            totalExpenses: row.totalExpenses,
            profitLoss: row.profitLoss,
            lastUpdated: new Date(row.lastUpdated),
            synced: true,
          },
          create: {
            id: row.id,
            userId: user.id,
            restaurantId: restaurant.id,
            branchId,
            date: new Date(String(row.date).split('T')[0] + 'T12:00:00Z'),
            totalRevenue: row.totalRevenue,
            totalExpenses: row.totalExpenses,
            profitLoss: row.profitLoss,
            lastUpdated: new Date(row.lastUpdated),
            synced: true,
          },
        })
      }

      // Sort entity changes so parent entities are applied before children to
      // avoid foreign-key violations (e.g. inventoryItem before inventoryPurchase).
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
      }
      const sortedChanges = [...changes].sort(
        (a, b) => (ENTITY_ORDER[a.entityType] ?? 99) - (ENTITY_ORDER[b.entityType] ?? 99),
      )

      // Remap local restaurant IDs in payloads to the resolved cloud restaurant's actual ID.
      // The desktop sends its local SQLite primary key which doesn't exist on the cloud.
      for (const change of sortedChanges) {
        const p = change.payload as Record<string, any> | undefined
        change.restaurantId = change.scopeId === GLOBAL_SYNC_SCOPE_ID ? null : restaurant.id
        // Remap child entities' restaurantId foreign key
        if (p && typeof p.restaurantId === 'string' && p.restaurantId !== restaurant.id) {
          p.restaurantId = restaurant.id
        }
        if (isRestaurantWideSyncEntity(change.entityType)) {
          change.branchId = null
        } else if (branchId && change.scopeId !== GLOBAL_SYNC_SCOPE_ID) {
          change.branchId = branchId
          if (p && p.branchId == null) {
            p.branchId = branchId
          }
        }
        // Remap the restaurant entity's own id to the cloud id.
        // Without this, the upsert tries to CREATE a second restaurant row with the desktop's
        // local SQLite id, which collides on the unique syncRestaurantId column and rolls back
        // the entire transaction — silently dropping all dishes, tables, and other child rows.
        if (change.entityType === 'restaurant') {
          change.entityId = restaurant.id
          if (p) p.id = restaurant.id
        }
      }

      const appliedEntityChanges = await applyIncomingSyncChanges(tx, sortedChanges, { localDeviceId: 'cloud', remapUserId: user.id })
      for (const change of appliedEntityChanges.appliedChanges) {
        await recordRemoteChangeForPull(tx, {
          ...change,
          restaurantId: change.scopeId === GLOBAL_SYNC_SCOPE_ID ? null : restaurant.id,
          branchId: change.scopeId === GLOBAL_SYNC_SCOPE_ID || isRestaurantWideSyncEntity(change.entityType)
            ? null
            : (change.branchId ?? branchId),
          payload: change.payload && typeof change.payload === 'object'
            ? {
                ...(change.payload as Record<string, unknown>),
                ...(change.scopeId === GLOBAL_SYNC_SCOPE_ID
                  ? {}
                  : {
                      restaurantId: restaurant.id,
                      ...(!isRestaurantWideSyncEntity(change.entityType) && branchId ? { branchId: change.branchId ?? branchId } : {}),
                    }),
              }
            : change.payload,
        })
      }

      const pull = await collectPullChanges(tx, { restaurantId: restaurant.id, branchId, deviceId, pullCursors })

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
    }, { timeout: 9000 })

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
import { NextResponse } from 'next/server'
import { compare } from 'bcryptjs'
import { timingSafeEqual } from 'crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { applyIncomingSyncChanges, recordRemoteChangeForPull } from '@/lib/syncEngine'
import { logSyncActivity } from '@/lib/syncLogging'
import { CLOUD_SYNC_TARGET, BRANCH_REQUIRED_ENTITY_TYPES, GLOBAL_SYNC_SCOPE_ID, isRestaurantWideSyncEntity, latestSyncChangeTimestamp, latestSyncMutationId, mapSyncOutboxRows, type SyncChangeEnvelope } from '@/lib/syncOutbox'
import { createRateLimiter, getRateLimitKey } from '@/lib/rateLimit'
import { ensureMainBranchForRestaurant } from '@/lib/restaurantAccess'

const syncLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })

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
  const existingBranches = await db.branch.findMany({
    where: { restaurantId },
    select: { id: true, name: true, code: true, isMain: true, isActive: true },
    orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
  }) as BranchLookupRecord[]

  const branchIdRemap = new Map<string, string>()

  for (const change of changes) {
    if (change.entityType !== 'branch' && change.entityType !== 'restaurantBranch') continue
    if (change.operation === 'delete') continue

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
      : hintedBranch?.id ?? loneActiveMainBranch?.id ?? null,
  }
}

async function collectPullChanges(db: PrismaDb, params: {
  restaurantId: string
  branchId?: string | null
  deviceId?: string | null
  pullCursors?: Array<{ scopeId?: string; lastPulledAt?: string | null; lastMutationId?: string | null }>
}) {
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

  const whereClauses = normalizedCursorInputs.map((cursor) => ({
    scopeId: cursor.queryScopeId,
    ...(cursor.lastPulledAt ? { createdAt: { gt: new Date(String(cursor.lastPulledAt)) } } : {}),
  }))

  const rows = whereClauses.length > 0
    ? await db.syncOutbox.findMany({
        where: {
          OR: whereClauses as any,
          ...(params.branchId !== undefined
            ? {
                AND: [{
                  OR: [
                    { scopeId: GLOBAL_SYNC_SCOPE_ID },
                    { entityType: 'restaurant' },
                    { entityType: { in: ['branch', 'restaurantBranch'] } },
                    { branchId: params.branchId ?? null },
                  ],
                }],
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

    // Support both old (restaurantSyncId) and new (joinCode) restaurant identifiers
    const joinCode = String(parsedBody.joinCode ?? '').trim().toUpperCase() || null
    const restaurantSyncId = String(parsedBody.restaurantSyncId ?? '').trim() || null

    let user = await prisma.user.findUnique({ where: { email } })

    if (!user && sharedSecret && matchesSharedSecret(sharedSecret, configuredSharedSecret)) {
      const provision = parsedBody.provisionUser
      // Find restaurant by joinCode or restaurantSyncId
      const provisionRestaurant = joinCode
        ? await prisma.restaurant.findUnique({ where: { joinCode }, select: { id: true, branches: { where: { isMain: true }, select: { id: true }, take: 1 } } })
        : null
      user = await prisma.user.create({
        data: {
          email,
          name: typeof provision?.name === 'string' && provision.name ? provision.name : email,
          password: typeof provision?.passwordHash === 'string' && provision.passwordHash ? provision.passwordHash : '',
          role: typeof provision?.role === 'string' && provision.role ? provision.role : 'admin',
          isActive: true,
        },
      })
      if (provisionRestaurant) {
        // Link this user as a staff member for the restaurant
        await prisma.staff.create({
          data: {
            restaurantId: provisionRestaurant.id,
            name: user.name ?? email,
            role: user.role,
            username: email,
            isActive: true,
          },
        }).catch(() => {/* non-fatal if already exists */})
      }
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

    // Resolve restaurant — by joinCode (new), or by owner
    let restaurant: { id: string; name: string; ownerId: string } | null = null

    if (joinCode) {
      restaurant = await prisma.restaurant.findUnique({
        where: { joinCode },
        select: { id: true, name: true, ownerId: true },
      })
    }

    if (!restaurant) {
      restaurant = await prisma.restaurant.findFirst({
        where: { ownerId: user.id, deletedAt: null },
        select: { id: true, name: true, ownerId: true },
        orderBy: { createdAt: 'asc' },
      })
    }

    if (!restaurant) {
      return NextResponse.json({ error: 'No restaurant found for this account. Provide a valid joinCode.' }, { status: 403 })
    }

    await ensureMainBranchForRestaurant(restaurant.id)

    const batchId = String(parsedBody.batchId ?? '').trim()
    const payloadHash = String(parsedBody.payloadHash ?? '').trim()
    const deviceId = String(parsedBody.deviceId ?? '').trim() || null
    const branchId = String(parsedBody.branchId ?? '').trim() || null
    const branchIdentity = parsedBody.branchIdentity && typeof parsedBody.branchIdentity === 'object'
      ? {
          id: typeof parsedBody.branchIdentity.id === 'string' ? parsedBody.branchIdentity.id.trim() || null : null,
          code: typeof parsedBody.branchIdentity.code === 'string' ? parsedBody.branchIdentity.code.trim() : '',
          name: typeof parsedBody.branchIdentity.name === 'string' ? parsedBody.branchIdentity.name.trim() : '',
          isMain: Boolean(parsedBody.branchIdentity.isMain),
        }
      : null
    const changes = (Array.isArray(parsedBody.changes) ? parsedBody.changes : []) as SyncChangeEnvelope[]
    const pullCursors = Array.isArray(parsedBody.pullCursors) ? parsedBody.pullCursors : []

    const branchContext = await resolveCloudBranchContext(prisma, restaurant.id, branchId, branchIdentity, changes)
    const resolvedBranchId = branchContext.resolvedBranchId

    logSyncActivity('info', 'sync.cloud.started', {
      restaurantId: restaurant.id,
      deviceId,
      batchId,
      changes: changes.length,
    })

    const ENTITY_ORDER: Record<string, number> = {
      restaurant: 0,
      branch: 1,
      restaurantBranch: 1,
      restaurantTable: 2,
      dish: 3,
      inventoryItem: 4,
      staff: 5,
      dishIngredient: 6,
      inventoryPurchase: 7,
      inventoryAdjustmentLog: 8,
      inventoryBatchUsageLedger: 9,
      dishSale: 10,
      wasteLog: 11,
      employeeShift: 12,
      restaurantOrder: 13,
      orderItem: 14,
      journalEntry: 15,
    }

    const sortedChanges = [...changes].sort(
      (a, b) => (ENTITY_ORDER[a.entityType] ?? 99) - (ENTITY_ORDER[b.entityType] ?? 99),
    )

    const result = await prisma.$transaction(async (tx) => {
      const skippedEntityIds = new Set<string>()

      for (const change of sortedChanges) {
        const p = change.payload as Record<string, any> | undefined
        change.restaurantId = change.scopeId === GLOBAL_SYNC_SCOPE_ID ? null : restaurant!.id

        if (p && typeof p.restaurantId === 'string' && p.restaurantId !== restaurant!.id) {
          p.restaurantId = restaurant!.id
        }

        // Normalize old 'restaurantBranch' entity type to 'branch'
        if (change.entityType === 'restaurantBranch') {
          change.entityType = 'branch'
          const mappedBranchId = branchContext.branchIdRemap.get(normalizeSyncBranchValue(p?.id ?? change.entityId))
          if (mappedBranchId) {
            change.entityId = mappedBranchId
            if (p) p.id = mappedBranchId
          }
        }

        if (change.entityType === 'restaurant') {
          change.entityId = restaurant!.id
          if (p) p.id = restaurant!.id
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

        try {
          ensureKnownBranchId(change, branchContext.existingBranchIds, p)
        } catch (branchErr) {
          const reason = branchErr instanceof Error ? branchErr.message : String(branchErr)
          skippedEntityIds.add(change.entityId)
          logSyncActivity('warn', 'sync.cloud.entity_skipped_unknown_branch', {
            restaurantId: restaurant!.id,
            entityType: change.entityType,
            entityId: change.entityId,
            reason,
          })
          continue
        }
      }

      const applicableChanges = skippedEntityIds.size > 0
        ? sortedChanges.filter((c) => !skippedEntityIds.has(c.entityId))
        : sortedChanges

      const billingUserId = restaurant!.ownerId
      const appliedEntityChanges = await applyIncomingSyncChanges(tx, applicableChanges, { localDeviceId: 'cloud', remapUserId: billingUserId })

      for (const { change: failedChange, error: failedError } of appliedEntityChanges.failedChanges ?? []) {
        logSyncActivity('warn', 'sync.cloud.entity_apply_failed', {
          restaurantId: restaurant!.id,
          entityType: failedChange.entityType,
          entityId: failedChange.entityId,
          error: failedError,
        })
      }

      if (appliedEntityChanges.failedChanges.length > 0) {
        try {
          await tx.$queryRaw`SELECT 1`
        } catch {
          const failures = appliedEntityChanges.failedChanges
            .map((f) => `[${f.change.entityType}:${f.change.entityId}] ${f.error}`)
            .join('; ')
          throw new Error(`Sync transaction aborted by entity failure: ${failures}`)
        }
      }

      for (const change of appliedEntityChanges.appliedChanges) {
        await recordRemoteChangeForPull(tx, {
          ...change,
          restaurantId: change.scopeId === GLOBAL_SYNC_SCOPE_ID ? null : restaurant!.id,
          branchId: change.scopeId === GLOBAL_SYNC_SCOPE_ID || isRestaurantWideSyncEntity(change.entityType)
            ? null
            : (change.branchId ?? resolvedBranchId),
          payload: change.payload && typeof change.payload === 'object'
            ? {
                ...(change.payload as Record<string, unknown>),
                ...(change.scopeId === GLOBAL_SYNC_SCOPE_ID
                  ? {}
                  : {
                      restaurantId: restaurant!.id,
                      ...(!isRestaurantWideSyncEntity(change.entityType) && resolvedBranchId
                        ? { branchId: change.branchId ?? resolvedBranchId }
                        : {}),
                    }),
              }
            : change.payload,
        })
      }

      // Omit branchId so the manager receives changes from ALL branches, not just the
      // resolved branch. Waiter devices have their own branch-scoped pull endpoint
      // (/api/mobile/pull) and never reach this path.
      const pull = await collectPullChanges(tx, { restaurantId: restaurant!.id, deviceId, pullCursors })

      return {
        ok: true,
        batchId,
        message: pull.pullChanges.length > 0 || appliedEntityChanges.applied > 0
          ? 'Sync batch applied successfully.'
          : 'No local or remote changes to sync.',
        changes: appliedEntityChanges.applied,
        skipped: skippedEntityIds.size,
        conflicts: appliedEntityChanges.conflicts,
        pullChanges: pull.pullChanges,
        pullCursors: pull.pullCursors,
      }
    }, { timeout: 55000 })

    logSyncActivity(result.conflicts > 0 || result.skipped > 0 ? 'warn' : 'info', 'sync.cloud.completed', {
      restaurantId: restaurant.id,
      deviceId,
      batchId,
      changes: result.changes,
      skipped: result.skipped,
      conflicts: result.conflicts,
      pullChanges: result.pullChanges.length,
    })

    return NextResponse.json(result)
  } catch (error) {
    logSyncActivity('error', 'sync.cloud.failed', {
      deviceId: String(parsedBody?.deviceId ?? '').trim() || null,
      batchId: String(parsedBody?.batchId ?? '').trim() || null,
      error: error instanceof Error ? error.message : 'Failed to sync records',
    })

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync records' },
      { status: 500 },
    )
  }
}

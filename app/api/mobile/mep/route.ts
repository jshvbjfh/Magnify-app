import { NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

import { prisma } from '@/lib/prisma'
import { producePrepStock, produceDishPortions, undoPrepLog } from '@/lib/mepProduction'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export const dynamic = 'force-dynamic'

const SECRET = new TextEncoder().encode(
  process.env.NEXTAUTH_SECRET ?? 'fallback-secret-change-me'
)

const MEP_TRANSACTION_OPTIONS = { maxWait: 15000, timeout: 60000 } as const

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0, must-revalidate',
}

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...NO_STORE_HEADERS,
      ...(init?.headers ?? {}),
    },
  })
}

async function verifyToken(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) throw new Error('Unauthorized')
  const { payload } = await jwtVerify(token, SECRET)
  return payload as { sub: string; restaurantId: string; branchId: string | null; role: string }
}

async function resolveBranchId(restaurantId: string, tokenBranchId: string | null, requestedBranchId: unknown) {
  const requested = typeof requestedBranchId === 'string' && requestedBranchId.trim() ? requestedBranchId.trim() : null
  if (!requested || requested === tokenBranchId) return tokenBranchId

  const validBranch = await prisma.branch.findFirst({
    where: { id: requested, restaurantId, isActive: true },
    select: { id: true },
  })
  return validBranch ? requested : null
}

function serializeLog(log: {
  id: string
  clientLogId: string | null
  targetType: string
  targetId: string
  quantity: number
  unit: string | null
  totalCost: number
  costPerUnit: number
  madeBy: string | null
  madeAt: Date
  reversedAt: Date | null
}) {
  return {
    id: log.id,
    client_log_id: log.clientLogId ?? null,
    target_type: log.targetType,
    target_id: log.targetId,
    quantity: Number(log.quantity),
    unit: log.unit ?? null,
    total_cost: Number(log.totalCost),
    cost_per_unit: Number(log.costPerUnit),
    made_by: log.madeBy ?? null,
    made_at: log.madeAt.toISOString(),
    reversed: log.reversedAt ? 1 : 0,
  }
}

/** POST /api/mobile/mep — MEP list management + "qty prepared" logging for the waiter/kitchen apps */
export async function POST(req: Request) {
  try {
    const claims = await verifyToken(req)
    const restaurantId = claims.restaurantId
    if (!restaurantId) return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body.action !== 'string') {
      return jsonNoStore({ error: 'Missing action' }, { status: 400 })
    }

    const branchId = await resolveBranchId(restaurantId, claims.branchId ?? null, body.branchId)
    if (!branchId) {
      return jsonNoStore({ error: 'Station not found or not accessible.' }, { status: 403 })
    }

    const action = body.action
    const targetType = body.targetType === 'dish' ? 'dish' : body.targetType === 'prep' ? 'prep' : null
    const targetId = typeof body.targetId === 'string' && body.targetId.trim() ? body.targetId.trim() : null

    if (action === 'add-item') {
      if (!targetType || !targetId) return jsonNoStore({ error: 'Missing target' }, { status: 400 })

      // Validate the target exists in the catalog — staff pick, never create.
      let name: string | null = null
      let unit: string | null = null
      let remaining = 0
      if (targetType === 'prep') {
        const prep = await prisma.inventoryItem.findFirst({
          where: { id: targetId, restaurantId, branchId, type: 'prep', deletedAt: null },
          select: { name: true, unit: true, quantity: true },
        })
        if (!prep) return jsonNoStore({ error: 'Prep not found' }, { status: 404 })
        name = prep.name
        unit = prep.unit ?? null
        remaining = Number(prep.quantity ?? 0)
      } else {
        const dish = await prisma.dish.findFirst({
          where: { id: targetId, restaurantId, isActive: true, deletedAt: null },
          select: { name: true, preparedPortions: true },
        })
        if (!dish) return jsonNoStore({ error: 'Dish not found' }, { status: 404 })
        name = dish.name
        unit = 'portion'
        remaining = Number(dish.preparedPortions ?? 0)
      }

      const addedBy = typeof body.addedBy === 'string' ? body.addedBy : null
      const item = await prisma.mepListItem.upsert({
        where: { branchId_targetType_targetId: { branchId, targetType, targetId } },
        update: { deletedAt: null, addedBy },
        create: { restaurantId, branchId, targetType, targetId, addedBy },
      })
      await enqueueSyncChange(prisma, {
        restaurantId,
        branchId,
        entityType: 'mepListItem',
        entityId: item.id,
        operation: 'upsert',
        payload: item,
      })

      return jsonNoStore({
        ok: true,
        item: {
          id: item.id,
          restaurant_id: item.restaurantId,
          branch_id: item.branchId,
          target_type: item.targetType,
          target_id: item.targetId,
          name,
          unit,
          remaining,
          updated_at: item.updatedAt.toISOString(),
        },
      })
    }

    if (action === 'remove-item') {
      if (!targetType || !targetId) return jsonNoStore({ error: 'Missing target' }, { status: 400 })

      const existing = await prisma.mepListItem.findUnique({
        where: { branchId_targetType_targetId: { branchId, targetType, targetId } },
      })
      if (!existing || existing.deletedAt) return jsonNoStore({ ok: true })

      const removed = await prisma.mepListItem.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      })
      await enqueueSyncChange(prisma, {
        restaurantId,
        branchId,
        entityType: 'mepListItem',
        entityId: removed.id,
        operation: 'upsert',
        payload: removed,
      })

      return jsonNoStore({ ok: true })
    }

    if (action === 'log') {
      if (!targetType || !targetId) return jsonNoStore({ error: 'Missing target' }, { status: 400 })

      const quantity = Number(body.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return jsonNoStore({ error: 'Quantity must be greater than 0' }, { status: 400 })
      }

      const clientLogId = typeof body.clientLogId === 'string' && body.clientLogId.trim() ? body.clientLogId.trim() : null
      const madeBy = typeof body.madeBy === 'string' && body.madeBy.trim() ? body.madeBy.trim() : null
      const madeAtRaw = typeof body.madeAt === 'string' ? new Date(body.madeAt) : null
      const madeAt = madeAtRaw && !Number.isNaN(madeAtRaw.getTime()) ? madeAtRaw : new Date()

      const result = await prisma.$transaction(async (tx) => {
        return targetType === 'prep'
          ? producePrepStock(tx, { restaurantId, branchId, prepItemId: targetId, quantity, madeBy, madeAt, clientLogId })
          : produceDishPortions(tx, { restaurantId, branchId, dishId: targetId, quantity, madeBy, madeAt, clientLogId })
      }, MEP_TRANSACTION_OPTIONS)

      return jsonNoStore({
        ok: true,
        log: serializeLog(result.log),
        remaining: result.remaining,
        warnings: result.warnings,
      })
    }

    if (action === 'undo') {
      const logId = typeof body.logId === 'string' && body.logId.trim() ? body.logId.trim() : null
      const clientLogId = typeof body.clientLogId === 'string' && body.clientLogId.trim() ? body.clientLogId.trim() : null
      if (!logId && !clientLogId) return jsonNoStore({ error: 'Missing log reference' }, { status: 400 })

      const result = await prisma.$transaction(
        (tx) => undoPrepLog(tx, { restaurantId, branchId, logId, clientLogId }),
        MEP_TRANSACTION_OPTIONS,
      )

      return jsonNoStore(result.ok ? { ok: true, remaining: result.remaining } : { ok: false, reason: result.reason })
    }

    return jsonNoStore({ error: 'Unknown action' }, { status: 400 })
  } catch (err: any) {
    if (err?.message === 'Unauthorized' || err?.name === 'JWTExpired' || err?.name === 'JWSSignatureVerificationFailed') {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }
    if (err instanceof Error && (err.message.endsWith('not found.') || err.message.includes('must be greater than 0') || err.message === 'Item is not a prep.')) {
      return jsonNoStore({ error: err.message }, { status: 400 })
    }
    console.error('[mobile/mep]', err)
    return jsonNoStore({ error: 'Server error' }, { status: 500 })
  }
}

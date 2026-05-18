import { NextResponse } from 'next/server'
import { jwtVerify } from 'jose'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { resolveCancellationApprover } from '@/lib/cancelApproval'
import { enqueueOrderSync } from '@/lib/restaurantOrders'

export const dynamic = 'force-dynamic'

const SECRET = new TextEncoder().encode(
  process.env.NEXTAUTH_SECRET ?? 'fallback-secret-change-me'
)

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0, must-revalidate',
}

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...(init?.headers ?? {}) },
  })
}

async function verifyToken(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) throw new Error('Unauthorized')
  const { payload } = await jwtVerify(token, SECRET)
  return payload as { sub: string; restaurantId: string; branchId: string | null; role: string }
}

/** POST /api/mobile/cancel-order
 *  Body: { orderId, supervisorPin, cancelReason }
 *
 *  Validates a 5-digit supervisor PIN server-side before canceling.
 *  branchId=null is refused — every cancellation must be branch-scoped.
 */
export async function POST(req: Request) {
  try {
    const claims = await verifyToken(req)
    const { restaurantId } = claims

    const context = await getRestaurantContextForUser(claims.sub)
    if (!context?.restaurantId || context.restaurantId !== restaurantId) {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }

    const effectiveBranchId = context.branchId ?? null

    // branchId=null is a critical security gap — reject hard
    if (!effectiveBranchId) {
      return jsonNoStore(
        { error: 'Branch assignment required to cancel orders. Contact your manager.' },
        { status: 403 },
      )
    }

    const body = await req.json() as {
      orderId?: unknown
      supervisorPin?: unknown
      cancelReason?: unknown
    }

    const orderId       = typeof body.orderId === 'string'       ? body.orderId.trim()       : ''
    const supervisorPin = typeof body.supervisorPin === 'string' ? body.supervisorPin.trim() : ''
    const cancelReason  = typeof body.cancelReason === 'string'  ? body.cancelReason.trim()  : 'Canceled by waiter'

    if (!orderId || !supervisorPin) {
      return jsonNoStore({ error: 'orderId and supervisorPin are required' }, { status: 400 })
    }

    const order = await prisma.restaurantOrder.findFirst({
      where: { id: orderId, restaurantId, branchId: effectiveBranchId },
    })

    if (!order) {
      return jsonNoStore({ error: 'Order not found' }, { status: 404 })
    }

    if (order.status === 'PAID') {
      return jsonNoStore({ error: 'Paid orders cannot be canceled' }, { status: 409 })
    }

    // Idempotent — if already canceled, return success
    if (order.status === 'CANCELED') {
      return jsonNoStore({ ok: true, alreadyCanceled: true, approvedBy: 'Supervisor' })
    }

    // Validate PIN against all employees who can approve cancellations in this branch
    const approver = await resolveCancellationApprover({
      restaurantId,
      branchId: effectiveBranchId,
      pin: supervisorPin,
    })

    if (!approver) {
      return jsonNoStore({ error: 'Invalid supervisor PIN — ask a manager to enter their PIN' }, { status: 403 })
    }

    const reason = cancelReason || 'Canceled by waiter'
    const now    = new Date()

    // Cancellation writes are committed in their own transaction.
    // enqueueOrderSync runs AFTER commit (using main prisma client) so that:
    //  1. A sync-queue failure never rolls back the actual cancellation.
    //  2. prisma.restaurantOrder.findUnique inside enqueueOrderSync is
    //     guaranteed to read the committed CANCELED row (not a tx-local view).
    await prisma.$transaction(async (tx) => {
      await tx.orderItem.updateMany({
        where: { orderId, status: 'ACTIVE' },
        data: { status: 'CANCELED', cancelReason: reason, canceledAt: now },
      })

      await tx.restaurantOrder.update({
        where: { id: orderId },
        data: { status: 'CANCELED', canceledAt: now, cancelReason: reason },
      })
    })

    // Enqueue AFTER the transaction commits — non-fatal if this fails
    try {
      await enqueueOrderSync(prisma, orderId, restaurantId, effectiveBranchId)
    } catch (enqueueErr) {
      console.error('[cancel-order] enqueueOrderSync failed for order', orderId, enqueueErr)
    }

    return jsonNoStore({ ok: true, approvedBy: approver.name })
  } catch (err) {
    if ((err as Error).message === 'Unauthorized') {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[cancel-order]', err)
    return jsonNoStore({ error: 'Server error' }, { status: 500 })
  }
}

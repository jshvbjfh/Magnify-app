import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { jwtVerify } from 'jose'

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

/** GET /api/mobile/pull — returns dishes + tables for the waiter's branch */
export async function GET(req: Request) {
  try {
    const claims = await verifyToken(req)

    const restaurantId = claims.restaurantId
    const userBranchId = claims.branchId ?? null

    if (!restaurantId) {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!userBranchId) {
      return jsonNoStore(
        { error: 'Your account has no branch assigned. Ask your manager to assign a branch before using the waiter app.' },
        { status: 403 }
      )
    }

    // Optional branch override: waiter app sends ?branchId= when user taps a branch chip.
    // Validate the requested branch belongs to this restaurant before accepting it.
    const url = new URL(req.url)
    const requestedBranchId = url.searchParams.get('branchId')
    let effectiveBranchId = userBranchId

    if (requestedBranchId && requestedBranchId !== userBranchId) {
      const validBranch = await prisma.branch.findFirst({
        where: { id: requestedBranchId, restaurantId, isActive: true },
        select: { id: true },
      })
      if (!validBranch) {
        return jsonNoStore({ error: 'Branch not found or not accessible.' }, { status: 403 })
      }
      effectiveBranchId = requestedBranchId
    }

    // Dishes are shared across all branches on the unified waiter menu.
    // Each dish retains its branchId for sale attribution — do not filter here.
    const dishWhere = { restaurantId, isActive: true }

    // Tables are restaurant-wide: all branch tables appear on the floor plan.
    const tableWhere = { restaurantId }

    // Recent orders window: last 3 days so waiter sees status changes (PAID/CANCELLED)
    // made by the manager without re-pushing. Scoped to the waiter's branch.
    const recentOrderSince = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

    const [dishes, tables, restaurant, approverEmployees, allBranches, recentOrders, incomingOrders] = await Promise.all([
      prisma.dish.findMany({
        where: dishWhere,
        select: {
          id: true, name: true, sellingPrice: true,
          category: true, menuType: true, isActive: true, branchId: true, restaurantId: true,
        },
        orderBy: { name: 'asc' },
      }),

      prisma.restaurantTable.findMany({
        where: tableWhere,
        select: {
          id: true, name: true, seats: true, status: true,
          branchId: true, restaurantId: true,
        },
        orderBy: { name: 'asc' },
      }),

      prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { id: true, name: true },
      }),

      // Staff with a stored order code (pin) can confirm orders offline.
      // Staff with a stored cancellationPin can approve order cancellations offline.
      // Hashes are sent, never plaintext.
      prisma.staff.findMany({
        where: {
          restaurantId,
          branches: { some: { branchId: effectiveBranchId } },
          isActive: true,
          OR: [{ pin: { not: null } }, { cancellationPin: { not: null } }],
        },
        select: { id: true, name: true, pin: true, cancellationPin: true },
      }),

      prisma.branch.findMany({
        where: { restaurantId, isActive: true },
        select: { id: true, name: true, code: true, isMain: true, type: true },
        orderBy: { name: 'asc' },
      }),

      // Recent order status updates — restaurant-wide so any branch's changes reconcile locally.
      prisma.restaurantOrder.findMany({
        where: {
          restaurantId,
          updatedAt: { gte: recentOrderSince },
        },
        select: {
          id: true,
          status: true,
          paymentMethod: true,
          paidAt: true,
          canceledAt: true,
          cancelReason: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),

      // Active orders + recent PAID/CANCELED (last 3 days) so the owner's device
      // has revenue history on a fresh install without relying on push-side data.
      prisma.restaurantOrder.findMany({
        where: {
          restaurantId,
          OR: [
            // UNCONFIRMED = guest QR orders awaiting a waiter's confirmation.
            // They must reach the waiter device so the waiter can confirm them.
            { status: { in: ['PENDING', 'OPEN', 'UNCONFIRMED'] } },
            { status: { in: ['PAID', 'CANCELED'] }, updatedAt: { gte: recentOrderSince } },
          ],
        },
        select: {
          id: true,
          restaurantId: true,
          branchId: true,
          tableId: true,
          tableName: true,
          orderNumber: true,
          status: true,
          paymentMethod: true,
          subtotalAmount: true,
          vatAmount: true,
          totalAmount: true,
          createdByName: true,
          paidAt: true,
          canceledAt: true,
          cancelReason: true,
          createdAt: true,
          updatedAt: true,
          items: {
            where: { status: 'ACTIVE' },
            select: {
              id: true,
              orderId: true,
              dishId: true,
              dishName: true,
              dishPrice: true,
              qty: true,
              status: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 300,
      }),
    ])

    // Normalise Prisma Decimal → number for SQLite
    const normalisedDishes = dishes.map(d => ({
      id: d.id,
      name: d.name,
      selling_price: Number(d.sellingPrice),
      category: d.category ?? null,
      menu_type: d.menuType ?? null,
      is_active: d.isActive ? 1 : 0,
      branch_id: d.branchId ?? null,
      restaurant_id: d.restaurantId,
    }))

    const normalisedTables = tables.map(t => ({
      id: t.id,
      name: t.name,
      seats: t.seats ?? null,
      status: t.status ?? 'available',
      branch_id: t.branchId ?? null,
      restaurant_id: t.restaurantId,
    }))

    if (normalisedDishes.length === 0) {
      // Diagnostic: log when pull returns an empty menu so server logs capture
      // the branchId context without requiring a debugger.
      console.warn('[mobile/pull] zero dishes returned', {
        restaurantId,
        branchId: effectiveBranchId,
        tablesCount: normalisedTables.length,
      })
    }

    return jsonNoStore({
      dishes: normalisedDishes,
      tables: normalisedTables,
      restaurant: restaurant ?? { id: restaurantId, name: 'Restaurant' },
      branches: allBranches,
      cancellationApprovers: approverEmployees
        .filter(e => e.cancellationPin != null)
        .map(e => ({
          id: e.id,
          name: e.name,
          pin_hash: e.cancellationPin as string,
        })),
      orderCodeHolders: approverEmployees
        .filter(e => e.pin != null)
        .map(e => ({
          id: e.id,
          name: e.name,
          pin_hash: e.pin as string,
        })),
      // Recent order status updates for local reconciliation on the waiter device.
      // Waiter app can update matching local rows without re-pushing.
      recentOrders: recentOrders.map(o => ({
        id: o.id,
        status: o.status,
        payment_method: o.paymentMethod ?? null,
        paid_at: o.paidAt?.toISOString() ?? null,
        canceled_at: o.canceledAt?.toISOString() ?? null,
        cancel_reason: o.cancelReason ?? null,
        updated_at: o.updatedAt.toISOString(),
      })),

      // Full active orders the waiter app may not have locally (e.g. QR/guest orders).
      // Same shape as the push payload so the waiter app can upsert them into SQLite.
      incomingOrders: incomingOrders.map(o => ({
        id: o.id,
        restaurant_id: o.restaurantId,
        branch_id: o.branchId,
        table_id: o.tableId ?? null,
        table_name: o.tableName ?? null,
        order_number: o.orderNumber,
        status: o.status,
        payment_method: o.paymentMethod ?? null,
        subtotal_amount: Number(o.subtotalAmount),
        vat_amount: Number(o.vatAmount),
        total_amount: Number(o.totalAmount),
        created_by_name: o.createdByName ?? null,
        paid_at: o.paidAt?.toISOString() ?? null,
        canceled_at: o.canceledAt?.toISOString() ?? null,
        cancel_reason: o.cancelReason ?? null,
        created_at: o.createdAt.toISOString(),
        updated_at: o.updatedAt.toISOString(),
        items: o.items.map(item => ({
          id: item.id,
          order_id: item.orderId,
          dish_id: item.dishId,
          dish_name: item.dishName,
          dish_price: Number(item.dishPrice),
          qty: item.qty,
          status: item.status,
          created_at: item.createdAt.toISOString(),
          updated_at: item.updatedAt.toISOString(),
        })),
      })),
    })
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[mobile/pull]', err)
    return jsonNoStore({ error: 'Server error' }, { status: 500 })
  }
}

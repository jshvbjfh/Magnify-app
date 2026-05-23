import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { jwtVerify } from 'jose'
import { resolveActiveStaffAccess } from '@/lib/mobileStaffAccess'

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
    // Resolve the current staff->restaurant->branch binding from the database.
    // JWT restaurant/branch claims can become stale after account repair or branch reassignment.
    const staffAccess = await resolveActiveStaffAccess(claims.sub)

    if (!staffAccess) {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }

    const restaurantId = staffAccess.restaurantId

    const userBranchId = staffAccess.branchId ?? null

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

    const dishWhere = { restaurantId, branchId: effectiveBranchId, isActive: true }

    const tableWhere = { restaurantId, branchId: effectiveBranchId }

    // Recent orders window: last 3 days so waiter sees status changes (PAID/CANCELLED)
    // made by the manager without re-pushing. Scoped to the waiter's branch.
    const recentOrderSince = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

    const [dishes, tables, restaurant, approverEmployees, allBranches, recentOrders] = await Promise.all([
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

      // Staff with a stored PIN can approve order cancellations offline.
      // PINs themselves are never sent — only the stored bcrypt hash.
      prisma.staff.findMany({
        where: {
          restaurantId,
          branches: { some: { branchId: effectiveBranchId } },
          isActive: true,
          pin: { not: null },
        },
        select: { id: true, name: true, pin: true },
      }),

      prisma.branch.findMany({
        where: { restaurantId, isActive: true },
        select: { id: true, name: true, code: true, isMain: true },
        orderBy: { name: 'asc' },
      }),

      // Recent order status updates so the waiter app can reconcile local copies.
      prisma.restaurantOrder.findMany({
        where: {
          restaurantId,
          branchId: effectiveBranchId,
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
      cancellationApprovers: approverEmployees.map(e => ({
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
    })
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[mobile/pull]', err)
    return jsonNoStore({ error: 'Server error' }, { status: 500 })
  }
}

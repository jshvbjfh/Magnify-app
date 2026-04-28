import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { jwtVerify } from 'jose'

const SECRET = new TextEncoder().encode(
  process.env.NEXTAUTH_SECRET ?? 'fallback-secret-change-me'
)

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
    const { restaurantId, branchId } = claims

    // A waiter with no branch assigned must not receive another branch's data.
    // Return 403 so the app shows a clear "account not configured" message rather
    // than silently returning the entire restaurant's menu.
    if (!branchId) {
      return NextResponse.json(
        { error: 'Your account has no branch assigned. Ask your manager to assign a branch before using the waiter app.' },
        { status: 403 }
      )
    }

    const [dishes, tables, restaurant] = await Promise.all([
      prisma.dish.findMany({
        where: {
          restaurantId,
          branchId,
          isActive: true,
        },
        select: {
          id: true, name: true, sellingPrice: true,
          category: true, isActive: true, branchId: true, restaurantId: true,
        },
        orderBy: { name: 'asc' },
      }),

      prisma.restaurantTable.findMany({
        where: {
          restaurantId,
          branchId,
        },
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
    ])

    // Normalise Prisma Decimal → number for SQLite
    const normalisedDishes = dishes.map(d => ({
      id: d.id,
      name: d.name,
      selling_price: Number(d.sellingPrice),
      category: d.category ?? null,
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

    return NextResponse.json({
      dishes: normalisedDishes,
      tables: normalisedTables,
      restaurant: restaurant ?? { id: restaurantId, name: 'Restaurant' },
    })
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[mobile/pull]', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

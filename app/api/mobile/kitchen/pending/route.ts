import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { jwtVerify } from 'jose'
import { ACTIVE_RESTAURANT_ORDER_STATUSES } from '@/lib/restaurantOrders'

export const dynamic = 'force-dynamic'

const SECRET = new TextEncoder().encode(
  process.env.NEXTAUTH_SECRET ?? 'fallback-secret-change-me'
)

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      ...(init?.headers ?? {}),
    },
  })
}

async function verifyToken(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) throw new Error('Unauthorized')
  const { payload } = await jwtVerify(token, SECRET)
  return payload as { sub: string; name?: string | null; restaurantId: string; branchId: string; role: string }
}

export async function GET(req: Request) {
  try {
    const context = await verifyToken(req)

    const [branch, items] = await Promise.all([
      prisma.branch.findUnique({
        where: { id: context.branchId },
        select: { name: true, type: true, restaurant: { select: { name: true } } },
      }),
      prisma.orderItem.findMany({
        where: {
          status: 'ACTIVE',
          kitchenStatus: { not: 'served' },
          dish: { branchId: context.branchId },
          order: {
            restaurantId: context.restaurantId,
            status: { in: [...ACTIVE_RESTAURANT_ORDER_STATUSES] },
            servedAt: null,
          },
        },
        include: { order: true },
        orderBy: { createdAt: 'asc' },
      }),
    ])

    const flattened = items.map((item) => ({
      id: item.id,
      orderId: item.order.id,
      orderNumber: item.order.orderNumber,
      tableName: item.order.tableName ?? 'Takeaway',
      dishName: item.dishName,
      qty: item.qty,
      notes: item.notes ?? null,
      kitchenStatus: item.kitchenStatus,
      addedAt: item.createdAt.toISOString(),
      waiterName: item.order.createdByName ?? null,
    }))

    return jsonNoStore({
      restaurantName: branch?.restaurant?.name ?? '',
      branchName: branch?.name ?? '',
      branchType: branch?.type ?? 'kitchen',
      items: flattened,
    })
  } catch (err) {
    console.error('[kitchen/pending]', err)
    return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
  }
}

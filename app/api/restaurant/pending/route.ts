import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

async function getRestaurantId(userId: string): Promise<string | null> {
  // Waiter/kitchen link takes priority over ownership
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { restaurantId: true } })
  if (user?.restaurantId) return user.restaurantId
  // Admin: check owned restaurant
  const owned = await prisma.restaurant.findUnique({ where: { ownerId: userId } })
  return owned?.id ?? null
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json([])

  const restaurantId = await getRestaurantId(session.user.id)
  if (!restaurantId) return NextResponse.json([])

  const orders = await prisma.pendingOrder.findMany({
    where: { restaurantId },
    include: { waiter: { select: { id: true, name: true } } },
    orderBy: { addedAt: 'asc' }
  })
  return NextResponse.json(orders)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const restaurantId = await getRestaurantId(session.user.id)
  if (!restaurantId) return NextResponse.json({ error: 'No restaurant found' }, { status: 400 })

  const { tableId, tableName, dishId, dishName, dishPrice, qty } = await req.json()

  const order = await prisma.pendingOrder.create({
    data: {
      restaurantId,
      tableId: tableId === 'takeaway' ? null : tableId || null,
      tableName: tableName || 'Takeaway',
      dishId,
      dishName,
      dishPrice: Number(dishPrice),
      qty: Number(qty) || 1,
      waiterId: session.user.id,
    }
  })

  // Mark table as occupied if it's a real table
  if (tableId && tableId !== 'takeaway') {
    await prisma.restaurantTable.updateMany({
      where: { id: tableId, restaurantId },
      data: { status: 'occupied' }
    })
  }

  return NextResponse.json(order, { status: 201 })
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const restaurantId = await getRestaurantId(session.user.id)
  if (!restaurantId) return NextResponse.json({ error: 'No restaurant' }, { status: 400 })

  const { orderId, tableKey, clearTable } = await req.json()

  if (orderId) {
    // Delete a single item
    await prisma.pendingOrder.deleteMany({ where: { id: orderId, restaurantId } })
  } else if (tableKey) {
    // Clear all items for a table (after payment)
    const tableId = tableKey === 'takeaway' ? null : tableKey
    if (tableId) {
      await prisma.pendingOrder.deleteMany({ where: { restaurantId, tableId } })
    } else {
      // Takeaway: delete those with null tableId
      await prisma.pendingOrder.deleteMany({ where: { restaurantId, tableId: null } })
    }

    // Mark table available
    if (clearTable && tableKey !== 'takeaway') {
      await prisma.restaurantTable.updateMany({
        where: { id: tableKey, restaurantId },
        data: { status: 'available' }
      })
    }
  }

  return NextResponse.json({ ok: true })
}

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Public — no auth required. Customer submits order from QR code page.
export async function POST(req: Request, { params }: { params: { restaurantId: string } }) {
  const { restaurantId } = params

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, ownerId: true },
  })
  if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })

  const body = await req.json()
  const { tableId, tableName, items, customerName } = body
  // items: [{ dishId, dishName, dishPrice, qty }]

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'No items in order' }, { status: 400 })
  }

  // Verify table belongs to this restaurant
  if (tableId) {
    const table = await prisma.restaurantTable.findFirst({ where: { id: tableId, restaurantId } })
    if (!table) return NextResponse.json({ error: 'Table not found' }, { status: 404 })
  }

  const notes = customerName ? `Customer: ${customerName}` : undefined

  // Create all order items and mark table occupied in one transaction
  await prisma.$transaction([
    ...items.map((item: { dishId: string; dishName: string; dishPrice: number; qty: number }) =>
      prisma.pendingOrder.create({
        data: {
          restaurantId,
          tableId: tableId || null,
          tableName: tableName || 'QR Order',
          dishId: item.dishId,
          dishName: item.dishName,
          dishPrice: Number(item.dishPrice),
          qty: Number(item.qty) || 1,
          waiterId: restaurant.ownerId, // Use owner as the waiter for customer-placed orders
          notes,
        },
      })
    ),
    ...(tableId ? [
      prisma.restaurantTable.update({
        where: { id: tableId },
        data: { status: 'occupied' },
      }),
    ] : []),
  ])

  return NextResponse.json({ success: true }, { status: 201 })
}

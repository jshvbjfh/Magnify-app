import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Public — returns table name for display on QR order page
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ restaurantId: string; tableId: string }> }
) {
  const { restaurantId, tableId } = await params
  // Try direct match, then fall back to syncRestaurantId-based restaurant
  let table = await prisma.restaurantTable.findFirst({
    where: { id: tableId, restaurantId },
    select: { name: true, seats: true },
  })
  if (!table) {
    const restaurant = await prisma.restaurant.findUnique({ where: { syncRestaurantId: restaurantId }, select: { id: true } })
    if (restaurant) {
      table = await prisma.restaurantTable.findFirst({
        where: { id: tableId, restaurantId: restaurant.id },
        select: { name: true, seats: true },
      })
    }
  }
  if (!table) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(table)
}

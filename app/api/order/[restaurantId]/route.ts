import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Public — no auth required. Returns restaurant info + active menu for QR ordering.
export async function GET(_req: Request, { params }: { params: Promise<{ restaurantId: string }> }) {
  const { restaurantId } = await params

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, name: true, ownerId: true },
  })
  if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })

  const dishes = await prisma.dish.findMany({
    where: { userId: restaurant.ownerId, isActive: true },
    select: { id: true, name: true, sellingPrice: true, category: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  })

  const table = await prisma.restaurantTable.findFirst({
    where: { restaurantId },
    select: { id: true },
  })

  return NextResponse.json({ restaurant: { id: restaurant.id, name: restaurant.name }, dishes })
}

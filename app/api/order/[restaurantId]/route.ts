import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ensureMainBranchForRestaurant, normalizeLegacyAutoRestaurantName } from '@/lib/restaurantAccess'

export async function GET(req: Request, { params }: { params: Promise<{ restaurantId: string }> }) {
  const { restaurantId } = await params

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      name: true,
      ownerId: true,
      owner: { select: { name: true } },
    },
  })
  if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })

  const { searchParams } = new URL(req.url)
  const requestedTableId = String(searchParams.get('tableId') ?? '').trim()
  let resolvedBranchId: string | null = null

  if (requestedTableId) {
    const table = await prisma.restaurantTable.findFirst({
      where: { id: requestedTableId, restaurantId: restaurant.id },
      select: { branchId: true },
    })
    resolvedBranchId = table?.branchId ?? null
  }

  if (!resolvedBranchId) {
    const mainBranch = await ensureMainBranchForRestaurant(restaurant.id)
    resolvedBranchId = mainBranch?.id ?? null
  }

  const dishes = await prisma.dish.findMany({
    where: {
      restaurantId: restaurant.id,
      ...(resolvedBranchId ? { branchId: resolvedBranchId } : {}),
      isActive: true,
    },
    select: { id: true, name: true, sellingPrice: true, category: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  })

  return NextResponse.json({
    restaurant: {
      id: restaurant.id,
      name: normalizeLegacyAutoRestaurantName(restaurant.name, restaurant.owner?.name),
      qrOrderingMode: 'order',
    },
    dishes,
  })
}

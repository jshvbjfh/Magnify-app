import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ensureMainBranchForRestaurant, normalizeLegacyAutoRestaurantName } from '@/lib/restaurantAccess'

// Public — no auth required. Returns restaurant info + active menu for guest table access.
export async function GET(req: Request, { params }: { params: Promise<{ restaurantId: string }> }) {
  const { restaurantId } = await params

  // Try primary ID first, then fall back to syncRestaurantId (QR from a different device)
  let restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      name: true,
      ownerId: true,
      qrOrderingMode: true,
      owner: { select: { name: true } },
    },
  })
  if (!restaurant) {
    restaurant = await prisma.restaurant.findUnique({
      where: { syncRestaurantId: restaurantId },
      select: {
        id: true,
        name: true,
        ownerId: true,
        qrOrderingMode: true,
        owner: { select: { name: true } },
      },
    })
  }
  if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
  if (restaurant.qrOrderingMode === 'disabled') {
    return NextResponse.json({ error: 'Guest menu is not enabled for this restaurant.' }, { status: 403 })
  }

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
      userId: restaurant.ownerId,
      restaurantId: restaurant.id,
      ...(resolvedBranchId
        ? { OR: [{ branchId: resolvedBranchId }, { branchId: null }] }
        : {}),
      isActive: true,
    },
    select: { id: true, name: true, sellingPrice: true, category: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  })

  return NextResponse.json({
    restaurant: {
      id: restaurant.id,
      name: normalizeLegacyAutoRestaurantName(restaurant.name, restaurant.owner?.name),
      qrOrderingMode: restaurant.qrOrderingMode,
    },
    dishes,
  })
}

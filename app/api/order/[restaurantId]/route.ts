import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ensureMainBranchForRestaurant, normalizeLegacyAutoRestaurantName } from '@/lib/restaurantAccess'

type PublicQrBranchPresentation = {
  qrMenuHeroImageUrl?: string | null
} | null

export async function GET(req: Request, { params }: { params: Promise<{ restaurantId: string }> }) {
  const { restaurantId } = await params

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      name: true,
      ownerId: true,
      qrOrderingMode: true,
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

  const [resolvedBranchRecord, dishes] = await Promise.all([
    resolvedBranchId
      ? prisma.branch.findUnique({ where: { id: resolvedBranchId } })
      : Promise.resolve(null),
    prisma.dish.findMany({
      where: {
        restaurantId: restaurant.id,
        isActive: true,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        sellingPrice: true,
        category: true,
        menuType: true,
        description: true,
        variants: {
          where: { isActive: true, deletedAt: null },
          select: { id: true, name: true, sellingPrice: true, sortOrder: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
      orderBy: [{ menuType: 'asc' }, { category: 'asc' }, { name: 'asc' }],
    }),
  ])

  const resolvedBranch = resolvedBranchRecord as PublicQrBranchPresentation

  return NextResponse.json({
    restaurant: {
      id: restaurant.id,
      name: normalizeLegacyAutoRestaurantName(restaurant.name, restaurant.owner?.name),
      qrOrderingMode: restaurant.qrOrderingMode === 'view_only'
        ? 'view_only'
        : restaurant.qrOrderingMode === 'disabled'
          ? 'disabled'
          : 'order',
      qrMenuHeroImageUrl: resolvedBranch?.qrMenuHeroImageUrl ?? null,
    },
    dishes,
  })
}

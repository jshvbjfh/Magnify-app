import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ensureMainBranchForRestaurant, getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { normalizeDishVariantPayload } from '@/lib/dishVariants'
import { enqueueSyncChange } from '@/lib/syncOutbox'
import { cached } from '@/lib/apiCache'

const dishInclude = {
  ingredients: {
    include: { inventoryItem: true },
  },
  variants: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }],
  },
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  const { searchParams } = new URL(req.url)
  const scope = String(searchParams.get('scope') ?? '').trim().toLowerCase()
  const restaurantWideScope = scope === 'restaurant'

  if (!restaurantId || (!branchId && !restaurantWideScope)) {
    return NextResponse.json(
      { error: 'No restaurant branch found for this account. Ask your administrator to check your account configuration.' },
      { status: 400 },
    )
  }

  const dishes = await prisma.dish.findMany({
    where: {
      restaurantId,
      deletedAt: null,
      ...(restaurantWideScope ? {} : { branchId: branchId! }),
    },
    include: dishInclude,
    orderBy: restaurantWideScope
      ? [{ menuType: 'asc' }, { category: 'asc' }, { name: 'asc' }]
      : { createdAt: 'desc' },
  })
  return cached(dishes)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId) {
    return NextResponse.json({ error: 'No restaurant found for this account' }, { status: 400 })
  }

  let resolvedBranchId: string | null = context.branchId
  if (!resolvedBranchId) {
    console.warn('[dishes/POST] context.branchId is null for user %s (restaurant %s) — resolving to main branch',
      session.user.id, context.restaurantId)
    const mainBranch = await ensureMainBranchForRestaurant(context.restaurantId)
    resolvedBranchId = mainBranch?.id ?? null
  }

  if (!resolvedBranchId) {
    return NextResponse.json({ error: 'No branch configured for this restaurant. Contact support.' }, { status: 400 })
  }

  const { name, sellingPrice, category, menuType, variants } = await req.json()
  if (!name || sellingPrice == null) {
    return NextResponse.json({ error: 'name and sellingPrice are required' }, { status: 400 })
  }

  const normalizedVariants = normalizeDishVariantPayload(variants)

  const dish = await prisma.$transaction(async (tx) => {
    const createdDish = await tx.dish.create({
      data: {
        restaurantId: context.restaurantId!,
        branchId: resolvedBranchId,
        name,
        sellingPrice: Number(sellingPrice),
        category: category || null,
        menuType: menuType || null,
      },
    })

    if (normalizedVariants.length > 0) {
      await tx.dishVariant.createMany({
        data: normalizedVariants.map((variant) => ({
          ...(variant.id ? { id: variant.id } : {}),
          dishId: createdDish.id,
          name: variant.name,
          sellingPrice: variant.sellingPrice,
          sortOrder: variant.sortOrder,
          isActive: variant.isActive,
        })),
      })
    }

    return tx.dish.findUnique({
      where: { id: createdDish.id },
      include: dishInclude,
    })
  })

  if (!dish) {
    return NextResponse.json({ error: 'Failed to create dish' }, { status: 500 })
  }

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: resolvedBranchId,
    entityType: 'dish',
    entityId: dish.id,
    operation: 'upsert',
    payload: dish,
  })

  return NextResponse.json(dish, { status: 201 })
}

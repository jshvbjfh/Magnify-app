import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ensureMainBranchForRestaurant, getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { normalizeDishVariantPayload } from '@/lib/dishVariants'
import { enqueueSyncChange } from '@/lib/syncOutbox'
import { isAddonCategory } from '@/lib/menuMetadata'

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

  const context = await getRestaurantContextForUser(session.user.id)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  const { searchParams } = new URL(req.url)
  const scope = String(searchParams.get('scope') ?? '').trim().toLowerCase()
  const restaurantWideScope = scope === 'restaurant'

  if (!restaurantId || (!branchId && !restaurantWideScope)) {
    return NextResponse.json(
      { error: 'No restaurant station found for this account. Ask your administrator to check your account configuration.' },
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
  return NextResponse.json(dishes)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
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
    return NextResponse.json({ error: 'No station configured for this restaurant. Contact support.' }, { status: 400 })
  }

  const { name, sellingPrice, category, menuType, variants } = await req.json()
  if (!name || sellingPrice == null) {
    return NextResponse.json({ error: 'name and sellingPrice are required' }, { status: 400 })
  }

  const normalizedVariants = normalizeDishVariantPayload(variants)

  // Add-ons are meant to be orderable from every station, not just the branch
  // the manager happened to be viewing — so this category fans out to every
  // branch instead of creating a single branch-scoped row.
  const branchIds = isAddonCategory(category)
    ? Array.from(new Set([
        resolvedBranchId,
        ...(await prisma.branch.findMany({
          where: { restaurantId: context.restaurantId },
          select: { id: true },
        })).map((b) => b.id),
      ]))
    : [resolvedBranchId]

  const createdDishes: Array<NonNullable<Awaited<ReturnType<typeof prisma.dish.findUnique>>>> = []

  for (const branchId of branchIds) {
    try {
      const dish = await prisma.$transaction(async (tx) => {
        const createdDish = await tx.dish.create({
          data: {
            restaurantId: context.restaurantId,
            branchId,
            name,
            sellingPrice: Number(sellingPrice),
            category: category || null,
            menuType: menuType || null,
          },
        })

        if (normalizedVariants.length > 0) {
          await tx.dishVariant.createMany({
            data: normalizedVariants.map((variant) => ({
              ...(variant.id && branchId === resolvedBranchId ? { id: variant.id } : {}),
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

      if (dish) createdDishes.push(dish)
    } catch (error) {
      // A dish with this name may already exist on another branch (unrelated
      // coincidence) — skip that branch rather than failing the whole request.
      const isUniqueConstraintError = Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'P2002')
      if (!isUniqueConstraintError) throw error
      console.warn('[dishes/POST] skipped branch %s — dish name already exists there', branchId)
    }
  }

  const primaryDish = createdDishes.find((d) => d.branchId === resolvedBranchId) ?? createdDishes[0]
  if (!primaryDish) {
    return NextResponse.json({ error: 'Failed to create dish' }, { status: 500 })
  }

  for (const dish of createdDishes) {
    await enqueueSyncChange(prisma, {
      restaurantId: context.restaurantId,
      branchId: dish.branchId,
      entityType: 'dish',
      entityId: dish.id,
      operation: 'upsert',
      payload: dish,
    })
  }

  return NextResponse.json(primaryDish, { status: 201 })
}

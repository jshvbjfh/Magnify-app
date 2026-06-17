import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { normalizeDishVariantPayload } from '@/lib/dishVariants'
import { ensureMainBranchForRestaurant, getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

const dishInclude = {
  ingredients: {
    include: { inventoryItem: true },
  },
  variants: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }],
  },
}

/** Resolve branchId for mutations — explicit, never silent null. */
async function requireBranchId(restaurantId: string, contextBranchId: string | null, userId: string): Promise<string | null> {
  if (contextBranchId) return contextBranchId
  console.warn('[dishes/[id]] context.branchId null for user %s (restaurant %s) — resolving to main branch', userId, restaurantId)
  const main = await ensureMainBranchForRestaurant(restaurantId)
  if (main) {
    console.warn('[dishes/[id]] resolved to main branch %s', main.id)
    return main.id
  }
  console.error('[dishes/[id]] no branch available for restaurant %s', restaurantId)
  return null
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const branchId = await requireBranchId(context.restaurantId, context.branchId, session.user.id)
  if (!branchId) return NextResponse.json({ error: 'No branch configured for this restaurant' }, { status: 400 })

  const { id } = await params
  const data = await req.json()
  const hasVariantsPayload = Array.isArray(data.variants)
  const normalizedVariants = hasVariantsPayload ? normalizeDishVariantPayload(data.variants) : null

  const dish = await prisma.$transaction(async (tx) => {
    const updated = await tx.dish.updateMany({
      where: { id, restaurantId: context.restaurantId, branchId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.sellingPrice !== undefined && { sellingPrice: Number(data.sellingPrice) }),
        ...(data.category !== undefined && { category: data.category }),
        ...(data.menuType !== undefined && { menuType: data.menuType }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    })

    if (normalizedVariants) {
      await tx.dishVariant.deleteMany({ where: { dishId: id } })
      if (normalizedVariants.length > 0) {
        await tx.dishVariant.createMany({
          data: normalizedVariants.map((variant) => ({
            ...(variant.id ? { id: variant.id } : {}),
            dishId: id,
            name: variant.name,
            sellingPrice: variant.sellingPrice,
            sortOrder: variant.sortOrder,
            isActive: variant.isActive,
          })),
        })
      }
    }

    const updatedDish = await tx.dish.findFirst({
      where: { id, restaurantId: context.restaurantId, branchId },
      include: dishInclude,
    })

    return { updated, updatedDish }
  })

  const updatedDish = dish.updatedDish
  if (updatedDish) {
    await enqueueSyncChange(prisma, {
      restaurantId: context.restaurantId,
      branchId,
      entityType: 'dish',
      entityId: updatedDish.id,
      operation: 'upsert',
      payload: updatedDish,
    })
  }

  if (!updatedDish) {
    return NextResponse.json({ error: 'Dish not found' }, { status: 404 })
  }

  return NextResponse.json(updatedDish)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const branchId = await requireBranchId(context.restaurantId, context.branchId, session.user.id)
  if (!branchId) return NextResponse.json({ error: 'No branch configured for this restaurant' }, { status: 400 })

  const { id } = await params
  const existingDish = await prisma.dish.findFirst({ where: { id, restaurantId: context.restaurantId, branchId } })
  await prisma.dish.deleteMany({ where: { id, restaurantId: context.restaurantId, branchId } })

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId,
    entityType: 'dish',
    entityId: id,
    operation: 'delete',
    payload: existingDish ? { id: existingDish.id } : { id },
  })

  return NextResponse.json({ success: true })
}

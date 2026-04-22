import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

// GET all ingredients for a dish
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { id } = await params
  const ingredients = await prisma.dishIngredient.findMany({
    where: {
      dishId: id,
      dish: {
        userId: context.billingUserId,
        restaurantId: context.restaurantId,
        branchId: context.branchId,
      },
    },
    include: { ingredient: true }
  })
  return NextResponse.json(ingredients)
}

// POST — add or update an ingredient in a dish recipe
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { ingredientId, quantityRequired } = await req.json()
  if (!ingredientId || quantityRequired == null) {
    return NextResponse.json({ error: 'ingredientId and quantityRequired required' }, { status: 400 })
  }

  const { id } = await params
  const [dish, ingredient] = await Promise.all([
    prisma.dish.findFirst({ where: { id, userId: context.billingUserId, restaurantId: context.restaurantId, branchId: context.branchId }, select: { id: true } }),
    prisma.inventoryItem.findFirst({ where: { id: ingredientId, userId: context.billingUserId, restaurantId: context.restaurantId, branchId: context.branchId, inventoryType: 'ingredient' }, select: { id: true } }),
  ])

  if (!dish) return NextResponse.json({ error: 'Dish not found' }, { status: 404 })
  if (!ingredient) return NextResponse.json({ error: 'Ingredient not found' }, { status: 404 })

  const row = await prisma.dishIngredient.upsert({
    where: { dishId_ingredientId: { dishId: id, ingredientId } },
    update: { quantityRequired: Number(quantityRequired) },
    create: { dishId: id, ingredientId, quantityRequired: Number(quantityRequired) }
  })

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    entityType: 'dishIngredient',
    entityId: `${row.dishId}:${row.ingredientId}`,
    operation: 'upsert',
    payload: row,
  })

  return NextResponse.json(row, { status: 201 })
}

// DELETE a single ingredient from dish recipe
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { ingredientId } = await req.json()
  const { id } = await params
  await prisma.dishIngredient.deleteMany({
    where: {
      dishId: id,
      ingredientId,
      dish: {
        userId: context.billingUserId,
        restaurantId: context.restaurantId,
        branchId: context.branchId,
      },
    }
  })

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    entityType: 'dishIngredient',
    entityId: `${id}:${ingredientId}`,
    operation: 'delete',
    payload: { dishId: id, ingredientId },
  })

  return NextResponse.json({ success: true })
}

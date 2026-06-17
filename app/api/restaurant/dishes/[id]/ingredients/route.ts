import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

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
        restaurantId: context.restaurantId,
        branchId: context.branchId,
      },
    },
    include: { inventoryItem: true },
  })
  return NextResponse.json(ingredients)
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { inventoryItemId, quantityRequired } = await req.json()
  if (!inventoryItemId || quantityRequired == null) {
    return NextResponse.json({ error: 'inventoryItemId and quantityRequired required' }, { status: 400 })
  }

  const { id } = await params
  const [dish, ingredient] = await Promise.all([
    prisma.dish.findFirst({ where: { id, restaurantId: context.restaurantId, branchId: context.branchId }, select: { id: true } }),
    prisma.inventoryItem.findFirst({ where: { id: inventoryItemId, restaurantId: context.restaurantId, branchId: context.branchId }, select: { id: true } }),
  ])

  if (!dish) return NextResponse.json({ error: 'Dish not found' }, { status: 404 })
  if (!ingredient) return NextResponse.json({ error: 'Ingredient not found' }, { status: 404 })

  const row = await prisma.dishIngredient.upsert({
    where: { dishId_inventoryItemId: { dishId: id, inventoryItemId } },
    update: { quantityRequired: Number(quantityRequired) },
    create: { dishId: id, inventoryItemId, quantityRequired: Number(quantityRequired) },
  })

  const updatedDish = await prisma.dish.findFirst({
    where: { id, restaurantId: context.restaurantId, branchId: context.branchId },
    include: {
      ingredients: {
        include: { inventoryItem: true },
      },
      variants: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      },
    },
  })

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    entityType: 'dishIngredient',
    entityId: `${row.dishId}:${row.inventoryItemId}`,
    operation: 'upsert',
    payload: row,
  })

  return NextResponse.json({ row, dish: updatedDish }, { status: 201 })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { inventoryItemId } = await req.json()
  const { id } = await params
  await prisma.dishIngredient.deleteMany({
    where: {
      dishId: id,
      inventoryItemId,
      dish: {
        restaurantId: context.restaurantId,
        branchId: context.branchId,
      },
    },
  })

  const updatedDish = await prisma.dish.findFirst({
    where: { id, restaurantId: context.restaurantId, branchId: context.branchId },
    include: {
      ingredients: {
        include: { inventoryItem: true },
      },
      variants: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      },
    },
  })

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    entityType: 'dishIngredient',
    entityId: `${id}:${inventoryItemId}`,
    operation: 'delete',
    payload: { dishId: id, inventoryItemId },
  })

  return NextResponse.json({ success: true, dish: updatedDish })
}

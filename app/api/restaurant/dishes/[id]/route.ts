import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { id } = await params
  const data = await req.json()
  const dish = await prisma.dish.updateMany({
    where: { id, userId: context.billingUserId, restaurantId: context.restaurantId, branchId: context.branchId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.sellingPrice !== undefined && { sellingPrice: Number(data.sellingPrice) }),
      ...(data.category !== undefined && { category: data.category }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    }
  })

  const updatedDish = await prisma.dish.findFirst({ where: { id, userId: context.billingUserId, restaurantId: context.restaurantId, branchId: context.branchId } })
  if (updatedDish) {
    await enqueueSyncChange(prisma, {
      restaurantId: context.restaurantId,
      branchId: context.branchId,
      entityType: 'dish',
      entityId: updatedDish.id,
      operation: 'upsert',
      payload: updatedDish,
    })
  }

  return NextResponse.json(dish)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { id } = await params
  const existingDish = await prisma.dish.findFirst({ where: { id, userId: context.billingUserId, restaurantId: context.restaurantId, branchId: context.branchId } })
  await prisma.dish.deleteMany({ where: { id, userId: context.billingUserId, restaurantId: context.restaurantId, branchId: context.branchId } })

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    entityType: 'dish',
    entityId: id,
    operation: 'delete',
    payload: existingDish ? { id: existingDish.id } : { id },
  })

  return NextResponse.json({ success: true })
}

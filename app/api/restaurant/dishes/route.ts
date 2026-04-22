import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  const billingUserId = context?.billingUserId ?? session.user.id
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null

  if (!restaurantId || !branchId) return NextResponse.json([])

  const dishes = await prisma.dish.findMany({
    where: { userId: billingUserId, restaurantId, branchId },
    include: {
      ingredients: {
        include: { ingredient: true }
      }
    },
    orderBy: { createdAt: 'desc' }
  })
  return NextResponse.json(dishes)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { name, sellingPrice, category } = await req.json()
  if (!name || sellingPrice == null) {
    return NextResponse.json({ error: 'name and sellingPrice are required' }, { status: 400 })
  }

  const dish = await prisma.dish.create({
    data: {
      userId: context.billingUserId,
      restaurantId: context.restaurantId,
      branchId: context.branchId,
      name,
      sellingPrice: Number(sellingPrice),
      category: category || null,
    }
  })

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    entityType: 'dish',
    entityId: dish.id,
    operation: 'upsert',
    payload: dish,
  })

  return NextResponse.json(dish, { status: 201 })
}

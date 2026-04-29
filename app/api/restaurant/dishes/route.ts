import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ensureMainBranchForRestaurant, getRestaurantContextForUser } from '@/lib/restaurantAccess'
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
  if (!context?.restaurantId) {
    return NextResponse.json({ error: 'No restaurant found for this account' }, { status: 400 })
  }

  // Explicit branchId resolution — never silently insert a dish with a null
  // branchId, as that makes it invisible to all waiter pull queries.
  // If the user's context already carries a branchId, use it.
  // Otherwise resolve the main branch explicitly and log the fallback so it is
  // auditable in server logs.
  let resolvedBranchId = context.branchId
  if (!resolvedBranchId) {
    console.warn('[dishes/POST] context.branchId is null for user %s (restaurant %s) — resolving to main branch',
      session.user.id, context.restaurantId)
    const mainBranch = await ensureMainBranchForRestaurant(context.restaurantId)
    resolvedBranchId = mainBranch?.id ?? null
    if (resolvedBranchId) {
      console.warn('[dishes/POST] resolved to main branch %s', resolvedBranchId)
    }
  }

  if (!resolvedBranchId) {
    // No branch exists at all — this restaurant is in a broken state.
    console.error('[dishes/POST] no branch available for restaurant %s — refusing dish create', context.restaurantId)
    return NextResponse.json({ error: 'No branch configured for this restaurant. Contact support.' }, { status: 400 })
  }

  const { name, sellingPrice, category } = await req.json()
  if (!name || sellingPrice == null) {
    return NextResponse.json({ error: 'name and sellingPrice are required' }, { status: 400 })
  }

  const dish = await prisma.dish.create({
    data: {
      userId: context.billingUserId,
      restaurantId: context.restaurantId,
      branchId: resolvedBranchId,
      name,
      sellingPrice: Number(sellingPrice),
      category: category || null,
    }
  })

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

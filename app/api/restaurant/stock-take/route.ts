import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = await getRestaurantContextForUser(session.user.id)
    if (!context?.restaurantId || !context.branchId) {
      return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
    }

    const { searchParams } = new URL(req.url)
    const asOf = searchParams.get('asOf')
    const asOfDate = asOf ? new Date(`${asOf}T23:59:59.999`) : null

    // Return the most recent stock take per ingredient (within asOf date if provided)
    const takes = await prisma.stockTake.findMany({
      where: {
        restaurantId: context.restaurantId,
        branchId: context.branchId,
        ...(asOfDate ? { takenAt: { lte: asOfDate } } : {}),
      },
      orderBy: { takenAt: 'desc' },
      select: { id: true, ingredientId: true, quantity: true, takenAt: true, notes: true },
    })

    // Deduplicate to latest per ingredient
    const latest = new Map<string, typeof takes[0]>()
    for (const t of takes) {
      if (!latest.has(t.ingredientId)) latest.set(t.ingredientId, t)
    }

    return NextResponse.json(Object.fromEntries(latest))
  } catch (error) {
    console.error('GET /api/restaurant/stock-take:', error)
    return NextResponse.json({ error: 'Failed to load stock takes' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = await getRestaurantContextForUser(session.user.id)
    if (!context?.restaurantId || !context.branchId) {
      return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
    }

    const body = await req.json().catch(() => null)
    const { ingredientId, quantity, takenAt, notes } = body ?? {}

    if (!ingredientId || quantity == null) {
      return NextResponse.json({ error: 'ingredientId and quantity are required' }, { status: 400 })
    }
    const qty = Number(quantity)
    if (!Number.isFinite(qty) || qty < 0) {
      return NextResponse.json({ error: 'quantity must be a non-negative number' }, { status: 400 })
    }

    const ingredient = await prisma.inventoryItem.findFirst({
      where: { id: ingredientId, restaurantId: context.restaurantId, branchId: context.branchId },
      select: { id: true },
    })
    if (!ingredient) return NextResponse.json({ error: 'Ingredient not found' }, { status: 404 })

    const entryDate = takenAt ? new Date(takenAt) : new Date()
    if (Number.isNaN(entryDate.getTime())) {
      return NextResponse.json({ error: 'Invalid takenAt date' }, { status: 400 })
    }

    const take = await prisma.stockTake.create({
      data: {
        restaurantId: context.restaurantId,
        branchId: context.branchId,
        ingredientId,
        quantity: qty,
        takenAt: entryDate,
        notes: notes ?? null,
        recordedBy: (session.user as any)?.name ?? null,
      },
      select: { id: true, ingredientId: true, quantity: true, takenAt: true, notes: true },
    })

    return NextResponse.json(take, { status: 201 })
  } catch (error) {
    console.error('POST /api/restaurant/stock-take:', error)
    return NextResponse.json({ error: 'Failed to save stock take' }, { status: 500 })
  }
}

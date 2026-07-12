import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'

async function getContext() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return null
  const ctx = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!ctx?.restaurantId || !ctx?.branchId) return null
  return ctx as { restaurantId: string; branchId: string }
}

// GET /api/restaurant/ingredients/prep-recipe?prepItemId=xxx
// Returns all sub-recipe rows for a prep item, with ingredient details
export async function GET(req: Request) {
  const ctx = await getContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const prepItemId = searchParams.get('prepItemId')
  if (!prepItemId) return NextResponse.json({ error: 'prepItemId required' }, { status: 400 })

  // Verify prep belongs to this branch
  const prep = await prisma.inventoryItem.findFirst({
    where: { id: prepItemId, restaurantId: ctx.restaurantId, branchId: ctx.branchId, type: 'prep' },
  })
  if (!prep) return NextResponse.json({ error: 'Prep not found' }, { status: 404 })

  const rows = await prisma.prepIngredient.findMany({
    where: { prepItemId },
    include: { ingredient: { select: { id: true, name: true, unit: true } } },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json(rows)
}

// POST — add a raw ingredient to a prep's sub-recipe
export async function POST(req: Request) {
  const ctx = await getContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { prepItemId, ingredientItemId, quantityRequired } = await req.json()
  if (!prepItemId || !ingredientItemId || !quantityRequired) {
    return NextResponse.json({ error: 'prepItemId, ingredientItemId and quantityRequired are required' }, { status: 400 })
  }

  const qty = Number(quantityRequired)
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ error: 'quantityRequired must be a positive number' }, { status: 400 })
  }

  const prep = await prisma.inventoryItem.findFirst({
    where: { id: prepItemId, restaurantId: ctx.restaurantId, branchId: ctx.branchId, type: 'prep' },
  })
  if (!prep) return NextResponse.json({ error: 'Prep not found' }, { status: 404 })

  const rawItem = await prisma.inventoryItem.findFirst({
    where: { id: ingredientItemId, restaurantId: ctx.restaurantId, branchId: ctx.branchId },
  })
  if (!rawItem) return NextResponse.json({ error: 'Ingredient not found' }, { status: 404 })

  if (ingredientItemId === prepItemId) {
    return NextResponse.json({ error: 'A prep cannot be an ingredient of itself' }, { status: 400 })
  }

  try {
    const row = await prisma.prepIngredient.create({
      data: { prepItemId, ingredientItemId, quantityRequired: qty },
      include: { ingredient: { select: { id: true, name: true, unit: true } } },
    })
    return NextResponse.json(row, { status: 201 })
  } catch (e: any) {
    if (e?.code === 'P2002') return NextResponse.json({ error: 'This ingredient is already in the sub-recipe' }, { status: 409 })
    return NextResponse.json({ error: e?.message || 'Failed to add ingredient' }, { status: 500 })
  }
}

// PUT — update quantityRequired for an existing sub-recipe row
export async function PUT(req: Request) {
  const ctx = await getContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id, quantityRequired } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const qty = Number(quantityRequired)
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ error: 'quantityRequired must be a positive number' }, { status: 400 })
  }

  // Verify the row belongs to this restaurant/branch via the prep item
  const existing = await prisma.prepIngredient.findFirst({
    where: { id },
    include: { prepItem: { select: { restaurantId: true, branchId: true } } },
  })
  if (!existing || existing.prepItem.restaurantId !== ctx.restaurantId || existing.prepItem.branchId !== ctx.branchId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const row = await prisma.prepIngredient.update({
    where: { id },
    data: { quantityRequired: qty },
    include: { ingredient: { select: { id: true, name: true, unit: true } } },
  })
  return NextResponse.json(row)
}

// DELETE — remove a sub-recipe row
export async function DELETE(req: Request) {
  const ctx = await getContext()
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const existing = await prisma.prepIngredient.findFirst({
    where: { id },
    include: { prepItem: { select: { restaurantId: true, branchId: true } } },
  })
  if (!existing || existing.prepItem.restaurantId !== ctx.restaurantId || existing.prepItem.branchId !== ctx.branchId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  await prisma.prepIngredient.delete({ where: { id } })
  return NextResponse.json({ success: true })
}

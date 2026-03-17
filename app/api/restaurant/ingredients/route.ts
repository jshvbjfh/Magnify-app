import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// GET all ingredients (inventory items tagged as 'ingredient')
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ingredients = await prisma.inventoryItem.findMany({
    where: { userId: session.user.id, inventoryType: 'ingredient' },
    orderBy: { name: 'asc' }
  })
  return NextResponse.json(ingredients)
}

// POST — create a new ingredient
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { name, unit, unitCost, quantity, reorderLevel, category } = await req.json()
  if (!name || !unit) {
    return NextResponse.json({ error: 'name and unit required' }, { status: 400 })
  }

  const item = await prisma.inventoryItem.create({
    data: {
      userId: session.user.id,
      name,
      unit,
      unitCost: unitCost != null ? Number(unitCost) : null,
      quantity: quantity != null ? Number(quantity) : 0,
      reorderLevel: reorderLevel != null ? Number(reorderLevel) : 0,
      category: category || null,
      inventoryType: 'ingredient'
    }
  })
  return NextResponse.json(item, { status: 201 })
}

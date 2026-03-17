import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// GET all ingredients for a dish
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ingredients = await prisma.dishIngredient.findMany({
    where: { dishId: params.id },
    include: { ingredient: true }
  })
  return NextResponse.json(ingredients)
}

// POST — add or update an ingredient in a dish recipe
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { ingredientId, quantityRequired } = await req.json()
  if (!ingredientId || quantityRequired == null) {
    return NextResponse.json({ error: 'ingredientId and quantityRequired required' }, { status: 400 })
  }

  const row = await prisma.dishIngredient.upsert({
    where: { dishId_ingredientId: { dishId: params.id, ingredientId } },
    update: { quantityRequired: Number(quantityRequired) },
    create: { dishId: params.id, ingredientId, quantityRequired: Number(quantityRequired) }
  })
  return NextResponse.json(row, { status: 201 })
}

// DELETE a single ingredient from dish recipe
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { ingredientId } = await req.json()
  await prisma.dishIngredient.deleteMany({
    where: { dishId: params.id, ingredientId }
  })
  return NextResponse.json({ success: true })
}

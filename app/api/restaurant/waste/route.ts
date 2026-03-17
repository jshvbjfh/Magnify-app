import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const logs = await prisma.wasteLog.findMany({
    where: { userId: session.user.id },
    include: { ingredient: true },
    orderBy: { date: 'desc' }
  })
  return NextResponse.json(logs)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { ingredientId, quantityWasted, reason, notes, date } = await req.json()
  if (!ingredientId || !quantityWasted || !reason) {
    return NextResponse.json({ error: 'ingredientId, quantityWasted, reason required' }, { status: 400 })
  }

  const qty = Number(quantityWasted)
  const ingredient = await prisma.inventoryItem.findUnique({ where: { id: ingredientId } })
  if (!ingredient) return NextResponse.json({ error: 'Ingredient not found' }, { status: 404 })

  const calculatedCost = qty * (ingredient.unitCost ?? 0)

  // 1. Deduct from inventory
  await prisma.inventoryItem.update({
    where: { id: ingredientId },
    data: { quantity: { decrement: qty } }
  })

  // 2. Find or create waste expense category + account
  let wasteCategory = await prisma.category.findFirst({ where: { name: 'Waste Expense' } })
  if (!wasteCategory) {
    wasteCategory = await prisma.category.create({
      data: { name: 'Waste Expense', type: 'expense', description: 'Food waste and spoilage costs' }
    })
  }
  let wasteAccount = await prisma.account.findFirst({ where: { name: 'Waste & Spoilage' } })
  if (!wasteAccount) {
    wasteAccount = await prisma.account.create({
      data: {
        code: 'REST-WST-001',
        name: 'Waste & Spoilage',
        categoryId: wasteCategory.id,
        type: 'expense',
        description: 'Restaurant waste expense'
      }
    })
  }

  // 3. Create expense transaction
  await prisma.transaction.create({
    data: {
      userId: session.user.id,
      accountId: wasteAccount.id,
      categoryId: wasteCategory.id,
      date: date ? new Date(date) : new Date(),
      description: `Waste: ${ingredient.name} – ${reason}`,
      amount: calculatedCost,
      type: 'debit',
      isManual: true,
      paymentMethod: 'Cash'
    }
  })

  // 4. Record waste log
  const log = await prisma.wasteLog.create({
    data: {
      userId: session.user.id,
      ingredientId,
      quantityWasted: qty,
      reason,
      notes: notes || null,
      date: date ? new Date(date) : new Date(),
      calculatedCost
    }
  })

  return NextResponse.json({ log, calculatedCost }, { status: 201 })
}

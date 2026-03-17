import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// GET — list all purchase batches for this user
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const ingredientId = searchParams.get('ingredientId')
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const purchases = await prisma.inventoryPurchase.findMany({
    where: {
      userId: session.user.id,
      ...(ingredientId ? { ingredientId } : {}),
      ...(from && to ? { purchasedAt: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } } : {}),
    },
    include: { ingredient: { select: { name: true, unit: true } } },
    orderBy: { purchasedAt: 'desc' },
  })

  return NextResponse.json(purchases)
}

// POST — record a new purchase batch
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { ingredientId, supplier, quantityPurchased, unitCost, purchasedAt } = body

  if (!ingredientId || !quantityPurchased || unitCost == null) {
    return NextResponse.json({ error: 'ingredientId, quantityPurchased and unitCost are required' }, { status: 400 })
  }

  const qty = Number(quantityPurchased)
  const cost = Number(unitCost)
  const totalCost = qty * cost

  // Verify the ingredient belongs to this user
  const ingredient = await prisma.inventoryItem.findFirst({
    where: { id: ingredientId, userId: session.user.id },
  })
  if (!ingredient) return NextResponse.json({ error: 'Ingredient not found' }, { status: 404 })

  const [purchase] = await prisma.$transaction([
    // 1. Create purchase batch
    prisma.inventoryPurchase.create({
      data: {
        userId: session.user.id,
        ingredientId,
        supplier: supplier || null,
        quantityPurchased: qty,
        remainingQuantity: qty,
        unitCost: cost,
        totalCost,
        purchasedAt: purchasedAt ? new Date(purchasedAt) : new Date(),
      },
    }),
    // 2. Add quantity to inventory
    prisma.inventoryItem.update({
      where: { id: ingredientId },
      data: {
        quantity: { increment: qty },
        unitCost: cost, // update reference cost to latest purchase price
        lastRestockedAt: purchasedAt ? new Date(purchasedAt) : new Date(),
      },
    }),
  ])

  // 3. Record as expense transaction
  try {
    let expCat = await prisma.category.findFirst({ where: { name: 'Cost of Goods' } })
    if (!expCat) expCat = await prisma.category.create({ data: { name: 'Cost of Goods', type: 'expense', description: 'Ingredient and inventory purchases' } })
    let expAcc = await prisma.account.findFirst({ where: { name: 'Inventory Purchases' } })
    if (!expAcc) expAcc = await prisma.account.create({ data: { code: 'INV-PUR-001', name: 'Inventory Purchases', categoryId: expCat.id, type: 'expense', description: 'Ingredient purchase expenses' } })
    let cashCat = await prisma.category.findFirst({ where: { name: 'Asset' } })
    if (!cashCat) cashCat = await prisma.category.create({ data: { name: 'Asset', type: 'asset', description: 'Asset accounts' } })
    let cashAcc = await prisma.account.findFirst({ where: { name: 'Cash' } })
    if (!cashAcc) cashAcc = await prisma.account.create({ data: { code: '1000', name: 'Cash', categoryId: cashCat.id, type: 'asset', description: 'Cash on hand' } })

    const pairId = `pair-inv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const desc = `Purchase: ${ingredient.name} (${qty} ${ingredient.unit}${supplier ? ` from ${supplier}` : ''})`
    const txDate = purchasedAt ? new Date(purchasedAt) : new Date()

    await prisma.transaction.createMany({
      data: [
        { userId: session.user.id, accountId: expAcc.id, categoryId: expCat.id, date: txDate, description: desc, amount: totalCost, type: 'debit', isManual: true, paymentMethod: 'Cash', pairId },
        { userId: session.user.id, accountId: cashAcc.id, categoryId: cashCat.id, date: txDate, description: desc, amount: totalCost, type: 'credit', isManual: true, paymentMethod: 'Cash', pairId },
      ],
    })
  } catch (e: any) {
    // Non-fatal — purchase batch is already saved
    console.error('Failed to record purchase transaction:', e.message)
  }

  return NextResponse.json({ purchase, totalCost }, { status: 201 })
}

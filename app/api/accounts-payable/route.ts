import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { recordJournalEntry } from '@/lib/accounting'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const ctx = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    if (!ctx.restaurantId) return NextResponse.json({ error: 'No restaurant linked' }, { status: 409 })

    const debts = await prisma.supplierDebt.findMany({
      where: { restaurantId: ctx.restaurantId, paidAt: null },
      orderBy: { purchaseDate: 'asc' },
    })

    const totalUnpaid = debts.reduce((s, r) => s + r.amount, 0)

    const bySupplier = new Map<string, typeof debts>()
    for (const debt of debts) {
      if (!bySupplier.has(debt.supplierName)) bySupplier.set(debt.supplierName, [])
      bySupplier.get(debt.supplierName)!.push(debt)
    }

    const payables = Array.from(bySupplier.entries()).map(([supplierName, items]) => ({
      supplierName,
      supplierPhone: items[0].supplierPhone ?? null,
      totalOwed: items.reduce((s, r) => s + r.amount, 0),
      openCount: items.length,
      lastActivityAt: items[items.length - 1].purchaseDate,
      items: items.map(i => ({ id: i.id, description: i.description, amount: i.amount, purchaseDate: i.purchaseDate })),
    }))

    return NextResponse.json({ payables, totalUnpaid, supplierCount: payables.length, openCount: debts.length })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { supplierName, description, amount, date, supplierPhone } = await req.json()
    if (!supplierName || !amount) return NextResponse.json({ error: 'supplierName and amount required' }, { status: 400 })

    const ctx = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    if (!ctx.restaurantId) return NextResponse.json({ error: 'No restaurant linked' }, { status: 409 })

    const purchaseDate = date ? new Date(date) : new Date()

    const debt = await prisma.supplierDebt.create({
      data: {
        restaurantId: ctx.restaurantId,
        branchId: ctx.branchId ?? null,
        supplierName: supplierName.trim(),
        supplierPhone: supplierPhone?.trim() || null,
        description: (description || supplierName).trim(),
        amount: parseFloat(amount),
        purchaseDate,
      },
    })

    await recordJournalEntry(prisma, {
      restaurantId: ctx.restaurantId,
      date: purchaseDate,
      description: `Credit purchase: ${description || supplierName} — ${supplierName}`,
      amount: parseFloat(amount),
      direction: 'out',
      accountName: 'General Expense',
      paymentMethod: 'Credit',
    })

    return NextResponse.json({ success: true, id: debt.id })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id, paymentMethod } = await req.json()
    if (!id || !paymentMethod) return NextResponse.json({ error: 'id and paymentMethod required' }, { status: 400 })

    const ctx = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    if (!ctx.restaurantId) return NextResponse.json({ error: 'No restaurant linked' }, { status: 409 })

    const debt = await prisma.supplierDebt.findFirst({ where: { id, restaurantId: ctx.restaurantId, paidAt: null } })
    if (!debt) return NextResponse.json({ error: 'Debt not found or already paid' }, { status: 404 })

    const paidAt = new Date()
    await prisma.supplierDebt.update({ where: { id }, data: { paidAt, paymentMethod } })

    await recordJournalEntry(prisma, {
      restaurantId: ctx.restaurantId,
      date: paidAt,
      description: `A/P payment: ${debt.description} — ${debt.supplierName}`,
      amount: debt.amount,
      direction: 'out',
      accountName: 'General Expense',
      paymentMethod,
    })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

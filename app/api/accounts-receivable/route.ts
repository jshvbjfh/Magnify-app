import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
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

    const sales = await prisma.creditSale.findMany({
      where: { restaurantId: ctx.restaurantId, paidAt: null },
      orderBy: { saleDate: 'asc' },
    })

    const totalUnpaid = sales.reduce((s, r) => s + r.amount, 0)

    const byCustomer = new Map<string, typeof sales>()
    for (const sale of sales) {
      if (!byCustomer.has(sale.customerName)) byCustomer.set(sale.customerName, [])
      byCustomer.get(sale.customerName)!.push(sale)
    }

    const receivables = Array.from(byCustomer.entries()).map(([customerName, items]) => ({
      customerName,
      customerPhone: items[0].customerPhone ?? null,
      totalOwed: items.reduce((s, r) => s + r.amount, 0),
      openCount: items.length,
      lastActivityAt: items[items.length - 1].saleDate,
      items: items.map(i => ({ id: i.id, description: i.description, amount: i.amount, saleDate: i.saleDate })),
    }))

    return NextResponse.json({ receivables, totalUnpaid, clientCount: receivables.length, openCount: sales.length })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { clientName, description, amount, date, customerPhone } = await req.json()
    if (!clientName || !amount) return NextResponse.json({ error: 'clientName and amount required' }, { status: 400 })

    const ctx = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    if (!ctx.restaurantId) return NextResponse.json({ error: 'No restaurant linked' }, { status: 409 })

    const saleDate = date ? new Date(date) : new Date()

    const sale = await prisma.creditSale.create({
      data: {
        restaurantId: ctx.restaurantId,
        branchId: ctx.branchId ?? null,
        customerName: clientName.trim(),
        customerPhone: customerPhone?.trim() || null,
        description: (description || clientName).trim(),
        amount: parseFloat(amount),
        saleDate,
      },
    })

    await recordJournalEntry(prisma, {
      restaurantId: ctx.restaurantId,
      date: saleDate,
      description: `Credit sale: ${description || clientName} — ${clientName}`,
      amount: parseFloat(amount),
      direction: 'in',
      accountName: 'Sales',
      paymentMethod: 'Credit',
    })

    return NextResponse.json({ success: true, id: sale.id })
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

    const sale = await prisma.creditSale.findFirst({ where: { id, restaurantId: ctx.restaurantId, paidAt: null } })
    if (!sale) return NextResponse.json({ error: 'Credit sale not found or already paid' }, { status: 404 })

    const paidAt = new Date()
    await prisma.creditSale.update({ where: { id }, data: { paidAt, paymentMethod } })

    await recordJournalEntry(prisma, {
      restaurantId: ctx.restaurantId,
      date: paidAt,
      description: `A/R payment: ${sale.description} — ${sale.customerName}`,
      amount: sale.amount,
      direction: 'in',
      accountName: 'Sales',
      paymentMethod,
    })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

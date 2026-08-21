import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { recordJournalEntry, recordReceivableCollection } from '@/lib/accounting'
import { isHotelBuffetLine, restaurantHasHotelBuffet } from '@/lib/hotelBuffet'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { calculateRestaurantOrderTotals } from '@/lib/restaurantOrders'

// Accounts Receivable is every open credit sale — which is what its name has
// always promised and what, until now, it did not deliver.
//
// Credit reaches the books by three different roads, and this page used to
// watch only the quietest of them:
//
//   'manual'  a credit_sales row, typed into the form below. The only source
//             this endpoint ever read, and the one almost nobody uses.
//   'order'   a bill settled at the till on the Credit tender. This is what a
//             waiter actually does when a regular says "put it on my tab", and
//             it books the whole order to A/R without writing a credit_sales
//             row — so the page stood empty while real tabs piled up.
//   'buffet'  SIROCCO Y SOL's hotel buffet (see lib/hotelBuffet.ts), whose
//             lines book to A/R even though the guest settled the rest of the
//             bill in cash. Only part of such an order is owed, so the amount
//             here is the buffet lines alone, never the order total.
//
// All three are shown together, grouped by customer, and all three clear the
// same way. An id is namespaced by source ('order:<id>') so PATCH knows which
// road a receivable came in on.
//
// Money must never be served from a cache: without this, Next can keep handing
// back a balance from before a collection landed.
export const dynamic = 'force-dynamic'

type ReceivableSource = 'manual' | 'order' | 'buffet'

type ReceivableItem = {
  id: string
  source: ReceivableSource
  description: string
  amount: number
  saleDate: Date
  customerName: string
  customerPhone: string | null
}

// A tab taken without a name still has to appear — an unnamed receivable is
// exactly the kind that goes uncollected.
const UNNAMED_CUSTOMER = 'Unnamed tab'

// The hotel settles its own guests' buffet, so those lines belong to the hotel
// rather than to whoever happened to be at the table.
const HOTEL_BUFFET_CUSTOMER = 'Hotel buffet'

function splitReceivableId(raw: string): { source: ReceivableSource; id: string } {
  const separator = raw.indexOf(':')
  if (separator === -1) return { source: 'manual', id: raw }
  const source = raw.slice(0, separator)
  if (source === 'manual' || source === 'order' || source === 'buffet') {
    return { source, id: raw.slice(separator + 1) }
  }
  return { source: 'manual', id: raw }
}

// Which stations this account may see. Main is the whole-restaurant view — the
// same rule /api/transactions applies — because an owner asking who owes them
// money means the business, not one till. An account whose session carries no
// resolvable station also sees everything: a lost branch claim in the JWT must
// never be the reason an owner is shown an empty A/R page.
async function resolveBranchFilter(restaurantId: string, sessionBranchId: string | null, requestedBranchId: string | null) {
  const branchId = requestedBranchId || sessionBranchId
  if (!branchId) return {}
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, restaurantId },
    select: { id: true, isMain: true },
  })
  if (!branch || branch.isMain) return {}
  return { branchId: branch.id }
}

// The buffet lines of one order, priced exactly as the ledger priced them at
// settlement — same helper, same discount handling — so the page and the
// journal can never disagree about what the hotel owes.
function buffetAmount(
  restaurantId: string,
  items: { dishId: string; dishName: string; dishPrice: number; qty: number; discountPercent: number | null }[],
  categoriesByDishId: Map<string, string | null>,
) {
  const lines = items.filter((item) => isHotelBuffetLine(restaurantId, item.dishName, categoriesByDishId.get(item.dishId)))
  if (!lines.length) return 0
  return calculateRestaurantOrderTotals(
    lines.map((item) => ({ dishPrice: Number(item.dishPrice), qty: Number(item.qty), discountPercent: item.discountPercent })),
  ).totalAmount
}

// Orders carrying an uncollected buffet leg. Skipped outright for every
// restaurant but the one with the arrangement, so this costs nothing elsewhere.
//
// Orders settled on the Credit tender are excluded: those book in full to A/R
// and are already listed as 'order' receivables. Counting their buffet lines
// again here would show the same money twice.
async function loadBuffetReceivables(restaurantId: string, branchFilter: { branchId?: string }): Promise<ReceivableItem[]> {
  if (!restaurantHasHotelBuffet(restaurantId)) return []

  const dishes = await prisma.dish.findMany({
    where: { restaurantId, deletedAt: null },
    select: { id: true, name: true, category: true },
  })
  const buffetDishes = dishes.filter((dish) => isHotelBuffetLine(restaurantId, dish.name, dish.category))
  if (!buffetDishes.length) return []

  const categoriesByDishId = new Map(dishes.map((dish) => [dish.id, dish.category]))
  const orders = await prisma.restaurantOrder.findMany({
    where: {
      restaurantId,
      status: 'PAID',
      paymentMethod: { not: 'Credit' },
      arCollectedAt: null,
      items: { some: { status: 'ACTIVE', dishId: { in: buffetDishes.map((dish) => dish.id) } } },
      ...branchFilter,
    },
    select: {
      id: true,
      orderNumber: true,
      tableName: true,
      paidAt: true,
      createdAt: true,
      arCustomerName: true,
      arCustomerPhone: true,
      items: {
        where: { status: 'ACTIVE' },
        select: { dishId: true, dishName: true, dishPrice: true, qty: true, discountPercent: true },
      },
    },
    orderBy: { paidAt: 'asc' },
  })

  return orders
    .map((order) => ({
      id: `buffet:${order.id}`,
      source: 'buffet' as const,
      description: `Hotel buffet — Order ${order.orderNumber}${order.tableName ? ` · ${order.tableName}` : ''}`,
      amount: buffetAmount(restaurantId, order.items, categoriesByDishId),
      saleDate: order.paidAt ?? order.createdAt,
      customerName: order.arCustomerName?.trim() || HOTEL_BUFFET_CUSTOMER,
      customerPhone: order.arCustomerPhone ?? null,
    }))
    .filter((item) => item.amount > 0)
}

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const ctx = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    if (!ctx.restaurantId) return NextResponse.json({ error: 'No restaurant linked' }, { status: 409 })
    const restaurantId = ctx.restaurantId

    const requestedBranchId = new URL(req.url).searchParams.get('branchId')?.trim() || null
    const branchFilter = await resolveBranchFilter(restaurantId, ctx.branchId, requestedBranchId)

    const [manualSales, creditOrders, buffetItems] = await Promise.all([
      prisma.creditSale.findMany({
        where: { restaurantId, paidAt: null, ...branchFilter },
        orderBy: { saleDate: 'asc' },
      }),
      prisma.restaurantOrder.findMany({
        where: {
          restaurantId,
          status: 'PAID',
          paymentMethod: 'Credit',
          arCollectedAt: null,
          ...branchFilter,
        },
        select: {
          id: true,
          orderNumber: true,
          tableName: true,
          totalAmount: true,
          paidAt: true,
          createdAt: true,
          arCustomerName: true,
          arCustomerPhone: true,
        },
        orderBy: { paidAt: 'asc' },
      }),
      loadBuffetReceivables(restaurantId, branchFilter),
    ])

    const items: ReceivableItem[] = [
      ...manualSales.map((sale) => ({
        id: `manual:${sale.id}`,
        source: 'manual' as const,
        description: sale.description,
        amount: sale.amount,
        saleDate: sale.saleDate,
        customerName: sale.customerName?.trim() || UNNAMED_CUSTOMER,
        customerPhone: sale.customerPhone ?? null,
      })),
      ...creditOrders.map((order) => ({
        id: `order:${order.id}`,
        source: 'order' as const,
        description: `Order ${order.orderNumber}${order.tableName ? ` · ${order.tableName}` : ''}`,
        amount: order.totalAmount,
        saleDate: order.paidAt ?? order.createdAt,
        customerName: order.arCustomerName?.trim() || UNNAMED_CUSTOMER,
        customerPhone: order.arCustomerPhone ?? null,
      })),
      ...buffetItems,
    ].sort((a, b) => a.saleDate.getTime() - b.saleDate.getTime())

    const byCustomer = new Map<string, ReceivableItem[]>()
    for (const item of items) {
      const existing = byCustomer.get(item.customerName)
      if (existing) existing.push(item)
      else byCustomer.set(item.customerName, [item])
    }

    // Biggest debtor first: a page about who owes money should open on whoever
    // owes the most, not on whoever happened to run a tab first.
    const receivables = Array.from(byCustomer.entries())
      .map(([customerName, customerItems]) => ({
        customerName,
        customerPhone: customerItems.find((item) => item.customerPhone)?.customerPhone ?? null,
        totalOwed: customerItems.reduce((sum, item) => sum + item.amount, 0),
        openCount: customerItems.length,
        lastActivityAt: customerItems[customerItems.length - 1].saleDate,
        items: customerItems.map((item) => ({
          id: item.id,
          source: item.source,
          description: item.description,
          amount: item.amount,
          saleDate: item.saleDate,
        })),
      }))
      .sort((a, b) => b.totalOwed - a.totalOwed)

    return NextResponse.json({
      receivables,
      totalUnpaid: items.reduce((sum, item) => sum + item.amount, 0),
      clientCount: receivables.length,
      openCount: items.length,
    })
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

    // Granting credit books the revenue now and the money later:
    // DR Accounts Receivable, CR Sales.
    await recordJournalEntry(prisma, {
      restaurantId: ctx.restaurantId,
      branchId: ctx.branchId ?? null,
      date: saleDate,
      description: `Credit sale: ${description || clientName} — ${clientName}`,
      amount: parseFloat(amount),
      direction: 'in',
      accountName: 'Sales',
      paymentMethod: 'Credit',
    })

    return NextResponse.json({ success: true, id: `manual:${sale.id}` })
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
    const restaurantId = ctx.restaurantId

    // A receivable cannot be settled by granting more credit.
    if (String(paymentMethod).trim().toLowerCase() === 'credit') {
      return NextResponse.json({ error: 'Choose how the money came in' }, { status: 400 })
    }

    // An id with no source prefix is a credit_sales row: that is all this
    // endpoint could ever return before, so older clients keep working.
    const { source, id: receivableId } = splitReceivableId(String(id))
    const paidAt = new Date()

    if (source === 'manual') {
      const sale = await prisma.creditSale.findFirst({ where: { id: receivableId, restaurantId, paidAt: null } })
      if (!sale) return NextResponse.json({ error: 'Credit sale not found or already paid' }, { status: 404 })

      await prisma.$transaction(async (tx) => {
        await tx.creditSale.update({ where: { id: sale.id }, data: { paidAt, paymentMethod } })
        await recordReceivableCollection(tx, {
          restaurantId,
          branchId: sale.branchId,
          date: paidAt,
          amount: sale.amount,
          paymentMethod,
          subject: sale.description,
          customerName: sale.customerName,
          reference: `AR-${sale.id.slice(-8).toUpperCase()}`,
        })
      })

      return NextResponse.json({ success: true })
    }

    // Both order-backed sources clear the same way — stamp the order collected
    // and book the money in — and differ only in how much is owed: the whole
    // bill on a Credit tender, the buffet lines alone on a cash one.
    const order = await prisma.restaurantOrder.findFirst({
      where: { id: receivableId, restaurantId, status: 'PAID' },
      select: {
        id: true,
        orderNumber: true,
        branchId: true,
        totalAmount: true,
        paymentMethod: true,
        arCustomerName: true,
        arCollectedAt: true,
        items: {
          where: { status: 'ACTIVE' },
          select: { dishId: true, dishName: true, dishPrice: true, qty: true, discountPercent: true },
        },
      },
    })
    if (!order) return NextResponse.json({ error: 'Credit sale not found' }, { status: 404 })
    if (order.arCollectedAt) return NextResponse.json({ error: 'Already collected' }, { status: 409 })

    let amount = order.totalAmount
    if (source === 'buffet') {
      const dishes = await prisma.dish.findMany({
        where: { id: { in: order.items.map((item) => item.dishId) } },
        select: { id: true, category: true },
      })
      amount = buffetAmount(restaurantId, order.items, new Map(dishes.map((dish) => [dish.id, dish.category])))
    } else if (order.paymentMethod !== 'Credit') {
      return NextResponse.json({ error: 'Order was not settled on credit' }, { status: 400 })
    }
    if (amount <= 0) return NextResponse.json({ error: 'Nothing outstanding on this order' }, { status: 400 })

    await prisma.$transaction(async (tx) => {
      // Guarded on arCollectedAt so two people pressing Paid at once can only
      // book the collection once.
      const stamped = await tx.restaurantOrder.updateMany({
        where: { id: order.id, restaurantId, arCollectedAt: null },
        data: { arCollectedAt: paidAt },
      })
      if (stamped.count === 0) return

      await recordReceivableCollection(tx, {
        restaurantId,
        branchId: order.branchId,
        date: paidAt,
        amount,
        paymentMethod,
        subject: `Order ${order.orderNumber}`,
        customerName: order.arCustomerName,
        reference: `AR-${order.id.slice(-8).toUpperCase()}`,
      })
    })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

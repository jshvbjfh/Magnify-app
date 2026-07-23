import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'

function normalizePaymentMethod(paymentMethod?: string): string {
  const raw = String(paymentMethod || 'Cash').trim().toLowerCase()
  if (raw.includes('mobile') || raw.includes('momo')) return 'Mobile Money'
  if (raw.includes('bank') || raw.includes('transfer') || raw.includes('card')) return 'Bank'
  if (raw.includes('credit')) return 'Credit'
  return 'Cash'
}

async function ensureCategoryByType(type: string, fallbackName: string) {
  let category = await prisma.category.findFirst({ where: { type } })
  if (!category) {
    category = await prisma.category.create({
      data: {
        name: fallbackName,
        type,
      } as any,
    })
  }
  return category
}

async function ensureAccount(params: { name: string; type: string; categoryId: string; code: string; description?: string }) {
  let account = await prisma.account.findFirst({ where: { name: params.name } })
  if (!account) {
    account = await prisma.account.create({
      data: {
        code: params.code,
        name: params.name,
        categoryId: params.categoryId,
        type: params.type,
        description: params.description,
      }
    })
  }
  return account
}

async function resolveSaleSettlementAccount(paymentMethod?: string) {
  const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod)
  if (normalizedPaymentMethod === 'Credit') {
    const assetCategory = await ensureCategoryByType('asset', 'Asset')
    const account = await ensureAccount({ name: 'Accounts Receivable', type: 'asset', categoryId: assetCategory.id, code: '1200', description: 'Customer balances for sales on credit' })
    return { paymentMethod: normalizedPaymentMethod, account }
  }
  if (normalizedPaymentMethod === 'Bank') {
    const assetCategory = await ensureCategoryByType('asset', 'Asset')
    const account = await ensureAccount({ name: 'Current Account', type: 'asset', categoryId: assetCategory.id, code: '1010', description: 'Bank account balance' })
    return { paymentMethod: normalizedPaymentMethod, account }
  }
  if (normalizedPaymentMethod === 'Mobile Money') {
    const assetCategory = await ensureCategoryByType('asset', 'Asset')
    const account = await ensureAccount({ name: 'Mobile Money', type: 'asset', categoryId: assetCategory.id, code: '1020', description: 'Mobile money balance' })
    return { paymentMethod: normalizedPaymentMethod, account }
  }
  const assetCategory = await ensureCategoryByType('asset', 'Asset')
  const account = await ensureAccount({ name: 'Cash', type: 'asset', categoryId: assetCategory.id, code: '1000', description: 'Cash on hand' })
  return { paymentMethod: 'Cash', account }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const billingUserId = context?.userId ?? session.user.id
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null

  if (!restaurantId || !branchId) {
    return NextResponse.json(
      { error: 'No restaurant station found for this account. Ask your administrator to check your account configuration.' },
      { status: 400 },
    )
  }

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  // Station comes from the caller when supplied (validated against this
  // restaurant) so a request fired right after a station switch isn't scoped to
  // the station just left, while the session's copy catches up in the background.
  // Main reports the whole restaurant, same as an explicit allBranches request.
  const requestedBranchId = searchParams.get('branchId')?.trim() || null
  const activeBranch = await prisma.branch.findFirst({
    where: { id: requestedBranchId ?? branchId, restaurantId },
    select: { id: true, isMain: true },
  })
  const scopedBranchId = activeBranch?.id ?? branchId
  const allBranches = searchParams.get('allBranches') === '1' || Boolean(activeBranch?.isMain)

  // F2-1: Removed redundant `userId: billingUserId` filter.
  // restaurantId + branchId is the correct scope. The userId filter could
  // silently exclude synced dish sales created under a different billing user.
  const sales = await prisma.dishSale.findMany({
    where: {
      restaurantId,
      ...(allBranches ? {} : { branchId: scopedBranchId }),
      ...(from && to && { saleDate: { gte: new Date(from), lte: new Date(to) } }),
    },
    include: { dish: true },
    orderBy: { saleDate: 'desc' }
  })

  const orderIds = Array.from(new Set(
    sales
      .map((sale) => sale.orderId)
      .filter((orderId): orderId is string => Boolean(orderId))
  ))

  const orders = orderIds.length > 0
    ? await prisma.restaurantOrder.findMany({
        // Only for labels (waiter / order number / table) on the sales above.
        // Deliberately NOT branch-filtered: these ids already come from sales
        // scoped to this station, and an order can be rung up at another
        // station's till — re-filtering by the till would blank out the labels
        // on exactly those cross-station sales.
        where: {
          id: { in: orderIds },
          restaurantId,
        },
        select: {
          id: true,
          orderNumber: true,
          tableName: true,
          createdByName: true,
        },
      })
    : []

  const orderMeta = new Map(orders.map((order) => [order.id, order]))

  return NextResponse.json(sales.map((sale) => {
    const order = sale.orderId ? orderMeta.get(sale.orderId) : null
    return {
      ...sale,
      waiterName: order?.createdByName ?? null,
      orderNumber: order?.orderNumber ?? null,
      tableName: order?.tableName ?? null,
    }
  }))
}

export async function POST(req: Request) {
  void req
  return NextResponse.json(
    { error: 'Dish sales can only be created from the paid-order flow' },
    { status: 405 }
  )
}


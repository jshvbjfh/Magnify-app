import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { buildRestaurantOrderTimeline, getRestaurantOrderDisplayStatus } from '@/lib/restaurantOrders'

function parseDateParam(value: string | null) {
  if (!value) return null
  const parsed = new Date(`${value}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function endOfDate(date: Date) {
  const end = new Date(date)
  end.setHours(23, 59, 59, 999)
  return end
}

function startOf(period: 'today' | 'week' | 'month' | 'all') {
  const now = new Date()
  if (period === 'all') return null
  if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (period === 'week') {
    const date = new Date(now)
    date.setDate(now.getDate() - 6)
    date.setHours(0, 0, 0, 0)
    return date
  }
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ orders: [], summary: null })

  const { searchParams } = new URL(req.url)
  const rawPeriod = (searchParams.get('period') ?? 'today').toLowerCase()
  const period = (['today', 'week', 'month', 'all'] as const).includes(rawPeriod as 'today' | 'week' | 'month' | 'all')
    ? rawPeriod as 'today' | 'week' | 'month' | 'all'
    : 'today'
  const status = (searchParams.get('status') ?? 'ALL').toUpperCase()
  const rawLimit = (searchParams.get('limit') ?? '40').toLowerCase()
  const limit = rawLimit === 'all'
    ? undefined
    : Math.min(Number(rawLimit) || 40, 500)
  const fromParam = parseDateParam(searchParams.get('from'))
  const toParam = parseDateParam(searchParams.get('to'))

  const from = fromParam ?? startOf(period)
  const to = toParam ? endOfDate(toParam) : new Date()
  const baseWhere = {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    ...(from ? { createdAt: { gte: from, lte: to } } : toParam ? { createdAt: { lte: to } } : {}),
  }

  const orders = await prisma.restaurantOrder.findMany({
    where: baseWhere,
    include: {
      items: {
        where: { status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
    ...(typeof limit === 'number' ? { take: limit } : {}),
  })

  const enriched = orders.map((order) => {
    const displayStatus = getRestaurantOrderDisplayStatus(order)
    return {
      ...order,
      displayStatus,
      cancelReason: displayStatus === 'CANCELED' ? order.cancelReason : null,
      cancellationApprovedByEmployeeName: displayStatus === 'CANCELED' ? order.cancellationApprovedByEmployeeName : null,
      timeline: buildRestaurantOrderTimeline(order),
    }
  })

  const filtered = status === 'ALL'
    ? enriched
    : enriched.filter((order) => order.displayStatus === status)

  const summary = enriched.reduce((acc, order) => {
    acc.total += 1
    if (order.displayStatus === 'PENDING') acc.pending += 1
    if (order.displayStatus === 'SERVED') acc.served += 1
    if (order.displayStatus === 'PAID') acc.paid += 1
    if (order.displayStatus === 'CANCELED') acc.canceled += 1
    return acc
  }, { total: 0, pending: 0, served: 0, paid: 0, canceled: 0 })

  return NextResponse.json({ orders: filtered, summary })
}
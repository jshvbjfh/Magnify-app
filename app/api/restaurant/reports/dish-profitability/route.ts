import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// GET — dish profitability report
// ?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const sales = await prisma.dishSale.findMany({
    where: {
      userId: session.user.id,
      ...(from && to ? { saleDate: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } } : {}),
    },
    include: {
      dish: { select: { id: true, name: true, sellingPrice: true, category: true } },
    },
  })

  // Aggregate by dish
  const map = new Map<string, {
    dishId: string
    dishName: string
    category: string | null
    sellingPrice: number
    qtySold: number
    totalRevenue: number
    totalCost: number
  }>()

  for (const sale of sales) {
    const key = sale.dishId
    const existing = map.get(key) ?? {
      dishId: sale.dishId,
      dishName: sale.dish.name,
      category: sale.dish.category,
      sellingPrice: sale.dish.sellingPrice,
      qtySold: 0,
      totalRevenue: 0,
      totalCost: 0,
    }
    existing.qtySold += sale.quantitySold
    existing.totalRevenue += sale.totalSaleAmount
    existing.totalCost += sale.calculatedFoodCost
    map.set(key, existing)
  }

  const rows = [...map.values()].map(r => ({
    ...r,
    totalProfit: r.totalRevenue - r.totalCost,
    profitMargin: r.totalRevenue > 0 ? Math.round(((r.totalRevenue - r.totalCost) / r.totalRevenue) * 100) : 0,
    costPerDish: r.qtySold > 0 ? r.totalCost / r.qtySold : 0,
  })).sort((a, b) => b.totalProfit - a.totalProfit)

  const totals = rows.reduce((acc, r) => ({
    qtySold: acc.qtySold + r.qtySold,
    totalRevenue: acc.totalRevenue + r.totalRevenue,
    totalCost: acc.totalCost + r.totalCost,
    totalProfit: acc.totalProfit + r.totalProfit,
  }), { qtySold: 0, totalRevenue: 0, totalCost: 0, totalProfit: 0 })

  return NextResponse.json({ rows, totals })
}

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { endOfRestaurantDay, startOfRestaurantDay } from '@/lib/restaurantDay'
import { MENU_TYPE_OPTIONS, MENU_TYPE_SECTION_ORDER, categoryGroupKey, getDishMenuTypeKey } from '@/lib/menuMetadata'

// Money must never be served from a cache — see dish-sales/route.ts for why.
export const dynamic = 'force-dynamic'

const SECTION_LABELS: Record<string, string> = {
  ...Object.fromEntries(MENU_TYPE_OPTIONS.map((o) => [o.value, o.label])),
  other: 'Other',
}

// GET — sales grouped by menu section (category) and named category (subcategory)
// ?from=YYYY-MM-DD&to=YYYY-MM-DD&branchId=...
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
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
  const fromDate = startOfRestaurantDay(from)
  const toDate = endOfRestaurantDay(to)

  const requestedBranchId = searchParams.get('branchId')?.trim() || null
  const activeBranch = await prisma.branch.findFirst({
    where: { id: requestedBranchId ?? branchId, restaurantId },
    select: { id: true, isMain: true },
  })
  const scopedBranchId = activeBranch?.id ?? branchId
  const allBranches = searchParams.get('allBranches') === '1' || Boolean(activeBranch?.isMain)

  const sales = await prisma.dishSale.findMany({
    where: {
      restaurantId,
      deletedAt: null,
      ...(allBranches ? {} : { branchId: scopedBranchId }),
      ...(fromDate && toDate
        ? {
            OR: [
              { businessDate: { gte: fromDate, lte: toDate } },
              { businessDate: null, saleDate: { gte: fromDate, lte: toDate } },
            ],
          }
        : {}),
    },
    select: {
      dishId: true,
      dishName: true,
      quantitySold: true,
      totalSaleAmount: true,
      dish: { select: { category: true, menuType: true } },
    },
  })

  // dishId -> aggregated row. Falls back to the sale's own dishName/category
  // when the dish has since been deleted, so a discontinued item still shows
  // up under the category it sold in rather than vanishing from the report.
  const byDish = new Map<string, { dishName: string; category: string | null; menuType: string | null; qty: number; amount: number }>()
  for (const sale of sales) {
    const key = sale.dishId
    const existing = byDish.get(key)
    const qty = Number(sale.quantitySold ?? 0)
    const amount = Number(sale.totalSaleAmount ?? 0)
    if (existing) {
      existing.qty += qty
      existing.amount += amount
    } else {
      byDish.set(key, {
        dishName: sale.dishName,
        category: sale.dish?.category ?? null,
        menuType: sale.dish?.menuType ?? null,
        qty,
        amount,
      })
    }
  }

  // Keyed on the folded spelling so one hand-typed category is one row, but
  // labelled with the spelling the most dishes actually use — a manager should
  // read their own words back, not a normalised key.
  type CategoryGroup = { name: string; qty: number; revenue: number; spellings: Map<string, number>; items: { dishId: string; dishName: string; qty: number; amount: number }[] }
  type SectionGroup = { key: string; label: string; qty: number; revenue: number; categories: Map<string, CategoryGroup> }

  const sections = new Map<string, SectionGroup>()
  for (const [dishId, row] of byDish) {
    const sectionKey = getDishMenuTypeKey(row.menuType, row.category)
    const categoryName = (row.category ?? '').trim() || 'Uncategorized'

    let section = sections.get(sectionKey)
    if (!section) {
      section = { key: sectionKey, label: SECTION_LABELS[sectionKey] ?? 'Other', qty: 0, revenue: 0, categories: new Map() }
      sections.set(sectionKey, section)
    }

    const categoryKey = categoryGroupKey(categoryName) || categoryName.toLowerCase()
    let category = section.categories.get(categoryKey)
    if (!category) {
      category = { name: categoryName, qty: 0, revenue: 0, spellings: new Map(), items: [] }
      section.categories.set(categoryKey, category)
    }
    category.spellings.set(categoryName, (category.spellings.get(categoryName) ?? 0) + 1)

    category.items.push({ dishId, dishName: row.dishName, qty: row.qty, amount: row.amount })
    category.qty += row.qty
    category.revenue += row.amount
    section.qty += row.qty
    section.revenue += row.amount
  }

  const sectionOrder = [...MENU_TYPE_SECTION_ORDER]
  const orderedSections = Array.from(sections.values())
    .sort((a, b) => {
      const ai = sectionOrder.indexOf(a.key as (typeof sectionOrder)[number])
      const bi = sectionOrder.indexOf(b.key as (typeof sectionOrder)[number])
      return (ai === -1 ? sectionOrder.length : ai) - (bi === -1 ? sectionOrder.length : bi)
    })
    .map((section) => ({
      key: section.key,
      label: section.label,
      qty: section.qty,
      revenue: section.revenue,
      categories: Array.from(section.categories.values())
        .sort((a, b) => b.revenue - a.revenue)
        .map((category) => ({
          // Whichever spelling covers the most dishes wins the label.
          name: Array.from(category.spellings.entries())
            .sort((a, b) => b[1] - a[1])[0]?.[0] ?? category.name,
          qty: category.qty,
          revenue: category.revenue,
          items: category.items.sort((a, b) => b.amount - a.amount),
        })),
    }))

  const totals = {
    revenue: orderedSections.reduce((sum, s) => sum + s.revenue, 0),
    qty: orderedSections.reduce((sum, s) => sum + s.qty, 0),
    items: byDish.size,
    categories: orderedSections.reduce((sum, s) => sum + s.categories.length, 0),
  }

  return NextResponse.json({ sections: orderedSections, totals })
}

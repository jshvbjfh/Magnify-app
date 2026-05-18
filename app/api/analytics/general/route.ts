export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

export async function GET() {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const context = await getRestaurantContextForUser(session.user.id)
		if (!context?.restaurantId) {
			return NextResponse.json({ topProducts: [], slowMoving: [], bestDays: [] })
		}

		const restaurantId = context.restaurantId
		const branchId = context.branchId

		const branchWhere = branchId ? { restaurantId, branchId } : { restaurantId }

		const [dishSales, inventoryItems] = await Promise.all([
			prisma.dishSale.findMany({
				where: { ...branchWhere, deletedAt: null },
				select: {
					dishId: true,
					dishName: true,
					quantitySold: true,
					totalSaleAmount: true,
					paymentMethod: true,
					saleDate: true,
				},
				orderBy: { saleDate: 'desc' },
			}),
			prisma.inventoryItem.findMany({
				where: { ...branchWhere, deletedAt: null },
				select: { id: true, name: true, unit: true, unitCost: true, quantity: true },
			}),
		])

		// ── 1. TOP SELLING PRODUCTS ──────────────────────────────────────────
		const productMap: Record<string, { name: string; totalQty: number; totalRevenue: number }> = {}
		for (const sale of dishSales) {
			if (!productMap[sale.dishId]) {
				productMap[sale.dishId] = { name: sale.dishName, totalQty: 0, totalRevenue: 0 }
			}
			productMap[sale.dishId].totalQty += sale.quantitySold
			productMap[sale.dishId].totalRevenue += sale.totalSaleAmount
		}
		const topProducts = Object.values(productMap)
			.sort((a, b) => b.totalRevenue - a.totalRevenue)
			.slice(0, 10)

		// ── 2. SLOW-MOVING INVENTORY ─────────────────────────────────────────
		const lastSaleByDishName: Record<string, Date> = {}
		for (const sale of dishSales) {
			const key = sale.dishName.toLowerCase()
			if (!lastSaleByDishName[key] || sale.saleDate > lastSaleByDishName[key]) {
				lastSaleByDishName[key] = sale.saleDate
			}
		}

		const slowMoving = inventoryItems
			.map((item) => {
				const lastSale = lastSaleByDishName[item.name.toLowerCase()] ?? null
				const daysSinceLastSale = lastSale
					? Math.floor((Date.now() - new Date(lastSale).getTime()) / (1000 * 60 * 60 * 24))
					: null
				return {
					name: item.name,
					unit: item.unit,
					unitCost: item.unitCost,
					lastSale: lastSale ? new Date(lastSale).toISOString().split('T')[0] : null,
					daysSinceLastSale,
					neverSold: lastSale === null,
				}
			})
			.filter((item) => item.neverSold || (item.daysSinceLastSale !== null && item.daysSinceLastSale > 30))
			.sort((a, b) => {
				if (a.neverSold && !b.neverSold) return -1
				if (!a.neverSold && b.neverSold) return 1
				return (b.daysSinceLastSale ?? 0) - (a.daysSinceLastSale ?? 0)
			})

		// ── 3. BEST DAY TO SELL ───────────────────────────────────────────────
		const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
		const dayMap: Record<number, { day: string; totalRevenue: number; salesCount: number }> = {}
		for (let i = 0; i < 7; i++) {
			dayMap[i] = { day: dayNames[i], totalRevenue: 0, salesCount: 0 }
		}
		for (const sale of dishSales) {
			const dow = new Date(sale.saleDate).getDay()
			dayMap[dow].totalRevenue += sale.totalSaleAmount
			dayMap[dow].salesCount += 1
		}
		const bestDays = Object.values(dayMap).sort((a, b) => b.totalRevenue - a.totalRevenue)

		return NextResponse.json({ topProducts, slowMoving, bestDays })
	} catch (error: any) {
		console.error('Analytics general error:', error)
		return NextResponse.json({ error: error.message }, { status: 500 })
	}
}

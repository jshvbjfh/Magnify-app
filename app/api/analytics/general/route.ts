export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		// Fetch all sales transactions
		const salesTxns = await prisma.transaction.findMany({
			where: {
				userId: session.user.id,
				type: 'credit',
				account: { name: 'Sales Revenue' }
			},
			include: { account: true },
			orderBy: { date: 'desc' }
		})

		// Fetch all inventory items
		const inventoryItems = await prisma.inventoryItem.findMany({
			where: { userId: session.user.id }
		})

		// ── 1. TOP SELLING PRODUCTS ──────────────────────────────────────────
		const productMap: Record<string, { name: string; totalQty: number; totalRevenue: number; unit: string }> = {}

		for (const txn of salesTxns) {
			const match = (txn.description || '').match(/Sale:\s*(.+?)\s*\(([0-9.]+)\s*(.+?)\)/)
			if (!match) continue
			const name = match[1].trim()
			const qty = parseFloat(match[2])
			const unit = match[3].trim()
			if (!productMap[name]) productMap[name] = { name, totalQty: 0, totalRevenue: 0, unit }
			productMap[name].totalQty += qty
			productMap[name].totalRevenue += Number(txn.amount)
		}

		const topProducts = Object.values(productMap)
			.sort((a, b) => b.totalRevenue - a.totalRevenue)
			.slice(0, 10)

		// ── 2. SLOW-MOVING INVENTORY ─────────────────────────────────────────
		const thirtyDaysAgo = new Date()
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

		// Build map of last sale date per product
		const lastSaleMap: Record<string, Date> = {}
		for (const txn of salesTxns) {
			const match = (txn.description || '').match(/Sale:\s*(.+?)\s*\(/)
			if (!match) continue
			const name = match[1].trim().toLowerCase()
			if (!lastSaleMap[name] || txn.date > lastSaleMap[name]) {
				lastSaleMap[name] = txn.date
			}
		}

		const slowMoving = inventoryItems
			.map((item: any) => {
				const lastSale = lastSaleMap[item.name.toLowerCase()] || null
				const daysSinceLastSale = lastSale
					? Math.floor((Date.now() - new Date(lastSale).getTime()) / (1000 * 60 * 60 * 24))
					: null
				return {
					name: item.name,
					unit: item.unit,
					unitPrice: item.unitPrice,
					lastSale: lastSale ? new Date(lastSale).toISOString().split('T')[0] : null,
					daysSinceLastSale,
					neverSold: lastSale === null
				}
			})
			.filter((item: any) => item.neverSold || (item.daysSinceLastSale !== null && item.daysSinceLastSale > 30))
			.sort((a: any, b: any) => {
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

		for (const txn of salesTxns) {
			const dow = new Date(txn.date).getDay()
			dayMap[dow].totalRevenue += Number(txn.amount)
			dayMap[dow].salesCount += 1
		}

		const bestDays = Object.values(dayMap).sort((a, b) => b.totalRevenue - a.totalRevenue)

		return NextResponse.json({ topProducts, slowMoving, bestDays })
	} catch (error: any) {
		console.error('Analytics general error:', error)
		return NextResponse.json({ error: error.message }, { status: 500 })
	}
}

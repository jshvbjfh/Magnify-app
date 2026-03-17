export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return new NextResponse('Unauthorized', { status: 401 })
		}

		const userId = session.user.id

		// Get revenue category
		const revenueCategory = await prisma.category.findFirst({
			where: { type: 'income' }
		})

		if (!revenueCategory) {
			return NextResponse.json([])
		}

		// Get revenue accounts
		const revenueAccounts = await prisma.account.findMany({
			where: { categoryId: revenueCategory.id }
		})

		const revenueAccountIds = revenueAccounts.map(acc => acc.id)

		// Get all revenue transactions
		const transactions = await prisma.transaction.findMany({
			where: {
				userId,
				accountId: { in: revenueAccountIds }
			},
			orderBy: { date: 'asc' }
		})

		if (transactions.length === 0) {
			return NextResponse.json([])
		}

		// Group by month
		const monthlyRevenue = new Map<string, number>()

		transactions.forEach(txn => {
			const date = new Date(txn.date)
			const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

			if (!monthlyRevenue.has(monthKey)) {
				monthlyRevenue.set(monthKey, 0)
			}

			const amount = txn.type === 'credit' ? txn.amount : -txn.amount
			monthlyRevenue.set(monthKey, monthlyRevenue.get(monthKey)! + amount)
		})

		// Convert to array
		const chartData = Array.from(monthlyRevenue.entries())
			.map(([month, revenue]) => ({
				month,
				revenue: Math.round(revenue * 100) / 100
			}))
			.sort((a, b) => a.month.localeCompare(b.month))

		return NextResponse.json(chartData)
	} catch (error: any) {
		console.error('Error fetching revenue data:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to fetch revenue data' },
			{ status: 500 }
		)
	}
}

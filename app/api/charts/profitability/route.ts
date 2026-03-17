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

		// Get all transactions
		const transactions = await prisma.transaction.findMany({
			where: { userId },
			orderBy: { date: 'asc' },
			include: {
				account: {
					include: {
						category: true
					}
				}
			}
		})

		if (transactions.length === 0) {
			return NextResponse.json([])
		}

		// Get revenue and expense categories
		const revenueCategory = await prisma.category.findFirst({
			where: { type: 'income' }
		})

		const expenseCategories = await prisma.category.findMany({
			where: { type: 'expense' }
		})

		// Group transactions by month
		const monthlyData = new Map<string, { revenue: number; expenses: number }>()

		transactions.forEach(txn => {
			const date = new Date(txn.date)
			const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

			if (!monthlyData.has(monthKey)) {
				monthlyData.set(monthKey, { revenue: 0, expenses: 0 })
			}

			const data = monthlyData.get(monthKey)!

			// Check if it's revenue
			if (revenueCategory && txn.account.categoryId === revenueCategory.id) {
				data.revenue += txn.type === 'credit' ? txn.amount : -txn.amount
			}

			// Check if it's expense
			const isExpense = expenseCategories.some(cat => cat.id === txn.account.categoryId)
			if (isExpense) {
				data.expenses += txn.type === 'debit' ? txn.amount : -txn.amount
			}
		})

		// Convert to array and calculate profit
		const chartData = Array.from(monthlyData.entries())
			.map(([month, data]) => ({
				month,
				revenue: Math.round(data.revenue * 100) / 100,
				expenses: Math.round(data.expenses * 100) / 100,
				profit: Math.round((data.revenue - data.expenses) * 100) / 100
			}))
			.sort((a, b) => a.month.localeCompare(b.month))

		return NextResponse.json(chartData)
	} catch (error: any) {
		console.error('Error fetching profitability data:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to fetch profitability data' },
			{ status: 500 }
		)
	}
}

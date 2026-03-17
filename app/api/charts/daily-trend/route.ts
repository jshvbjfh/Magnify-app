export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.email) {
			return new NextResponse('Unauthorized', { status: 401 })
		}

		const user = await prisma.user.findUnique({
			where: { email: session.user.email }
		})

		if (!user) {
			return new NextResponse('User not found', { status: 404 })
		}

		// Start date: January 4, 2026
		const startDate = new Date('2026-01-04T00:00:00')

		// Get all transactions from Jan 4 onwards
		const transactions = await prisma.transaction.findMany({
			where: {
				userId: user.id,
				date: {
					gte: startDate
				}
			},
			include: {
				category: true
			},
			orderBy: {
				date: 'asc'
			}
		})

		if (transactions.length === 0) {
			return NextResponse.json([])
		}

		// Group transactions by date
		const dailyData = new Map<string, { revenue: number; expenses: number }>()

		transactions.forEach(transaction => {
			const dateStr = transaction.date.toISOString().split('T')[0]
			
			if (!dailyData.has(dateStr)) {
				dailyData.set(dateStr, { revenue: 0, expenses: 0 })
			}

			const data = dailyData.get(dateStr)!
			const amount = transaction.amount

			if (transaction.category.type === 'income') {
				data.revenue += amount
			} else if (transaction.category.type === 'expense') {
				data.expenses += amount
			}
		})

		// Convert to array and calculate profit
		const result = Array.from(dailyData.entries()).map(([date, data]) => ({
			date,
			revenue: data.revenue,
			expenses: data.expenses,
			profit: data.revenue - data.expenses
		}))

		return NextResponse.json(result)
	} catch (error) {
		console.error('Error fetching daily trend:', error)
		return new NextResponse('Internal Server Error', { status: 500 })
	}
}

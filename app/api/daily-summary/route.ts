export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET(request: Request) {
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

		const { searchParams } = new URL(request.url)
		const dateParam = searchParams.get('date')

		if (!dateParam) {
			return new NextResponse('Date parameter required', { status: 400 })
		}

		// Parse the date and set time to start and end of day
		const selectedDate = new Date(dateParam)
		const startOfDay = new Date(selectedDate.setHours(0, 0, 0, 0))
		const endOfDay = new Date(selectedDate.setHours(23, 59, 59, 999))

		// Get all transactions up to and including this date
		const transactionsUpToDate = await prisma.transaction.findMany({
			where: {
				userId: user.id,
				date: {
					lte: endOfDay
				}
			},
			include: {
				category: true,
				account: true
			},
			orderBy: {
				date: 'asc'
			}
		})

		// Get transactions for just this specific day
		const transactionsForDay = await prisma.transaction.findMany({
			where: {
				userId: user.id,
				date: {
					gte: startOfDay,
					lte: endOfDay
				}
			},
			include: {
				category: true
			}
		})

		// Calculate revenue and expenses for the day
		let dailyRevenue = 0
		let dailyExpenses = 0

		transactionsForDay.forEach(tx => {
			if (tx.category.type === 'income') {
				dailyRevenue += tx.amount
			} else if (tx.category.type === 'expense') {
				dailyExpenses += tx.amount
			}
		})

		const dailyProfit = dailyRevenue - dailyExpenses

		// Calculate cash balance at end of day
		let cashBalance = 0
		
		transactionsUpToDate.forEach(tx => {
			// For cash account transactions
			if (tx.account.name.toLowerCase().includes('cash')) {
				if (tx.type === 'debit') {
					cashBalance += tx.amount
				} else if (tx.type === 'credit') {
					cashBalance -= tx.amount
				}
			}
		})

		return NextResponse.json({
			date: dateParam,
			revenue: dailyRevenue,
			expenses: dailyExpenses,
			profit: dailyProfit,
			cashBalance: cashBalance
		})
	} catch (error) {
		console.error('Error fetching daily summary:', error)
		return new NextResponse('Internal Server Error', { status: 500 })
	}
}

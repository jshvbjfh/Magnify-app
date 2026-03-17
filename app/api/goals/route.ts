import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET(request: Request) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return new NextResponse('Unauthorized', { status: 401 })
		}

		const userId = session.user.id
		const { searchParams } = new URL(request.url)
		const type = searchParams.get('type') // weekly or monthly

		const where: any = { userId }
		if (type) {
			where.type = type
		}

		const goals = await prisma.goal.findMany({
			where,
			orderBy: { startDate: 'desc' }
		})

		// Calculate actual performance for each goal
		const goalsWithProgress = await Promise.all(
			goals.map(async (goal: any) => {
				// Only calculate if the period has ended
				const now = new Date()
				const hasEnded = now >= goal.endDate

				let actualRevenue = 0
				if (hasEnded) {
					// Get revenue categories and accounts
					const revenueCategory = await prisma.category.findFirst({
						where: { type: 'income' }
					})

					if (revenueCategory) {
						const revenueAccounts = await prisma.account.findMany({
							where: { categoryId: revenueCategory.id }
						})

						const revenueAccountIds = revenueAccounts.map(acc => acc.id)

						// Get transactions within the goal period
						const revenueTransactions = await prisma.transaction.findMany({
							where: {
								userId,
								accountId: { in: revenueAccountIds },
								date: {
									gte: goal.startDate,
									lte: goal.endDate
								}
							}
						})

						actualRevenue = revenueTransactions.reduce((total, txn) => {
							return total + (txn.type === 'credit' ? txn.amount : -txn.amount)
						}, 0)
					}
				}

				const percentage = hasEnded && goal.targetAmount > 0
					? (actualRevenue / goal.targetAmount) * 100
					: 0

				return {
					...goal,
					actualRevenue,
					percentage: Math.round(percentage * 100) / 100,
					hasEnded
				}
			})
		)

		return NextResponse.json(goalsWithProgress)
	} catch (error: any) {
		console.error('Error fetching goals:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to fetch goals' },
			{ status: 500 }
		)
	}
}

export async function POST(request: Request) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return new NextResponse('Unauthorized', { status: 401 })
		}

		const userId = session.user.id
		const body = await request.json()
		const { type, targetAmount, startDate, endDate } = body

		// Be specific about what's missing
		const missingFields = []
		if (!type) missingFields.push('type (daily, weekly, or monthly)')
		if (!targetAmount) missingFields.push('targetAmount')
		if (!startDate) missingFields.push('startDate')
		if (!endDate) missingFields.push('endDate')

		if (missingFields.length > 0) {
			return NextResponse.json(
				{ error: `Missing required fields: ${missingFields.join(', ')}` },
				{ status: 400 }
			)
		}

		// Generate period string
		const start = new Date(startDate)
		let period = ''
		if (type === 'weekly') {
			const weekNumber = getWeekNumber(start)
			period = `${start.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`
		} else if (type === 'monthly') {
			period = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`
		}

		const goal = await prisma.goal.create({
			data: {
				userId,
				type,
				period,
				targetAmount: parseFloat(targetAmount),
				startDate: new Date(startDate),
				endDate: new Date(endDate)
			}
		})

		return NextResponse.json(goal)
	} catch (error: any) {
		console.error('Error creating goal:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to create goal' },
			{ status: 500 }
		)
	}
}

// Helper function to get week number
function getWeekNumber(date: Date): number {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
	const dayNum = d.getUTCDay() || 7
	d.setUTCDate(d.getUTCDate() + 4 - dayNum)
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
	return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
}

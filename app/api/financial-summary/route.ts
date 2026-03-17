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

		// Get Current Account (previously named Cash)
		const cashAccount = await prisma.account.findFirst({
			where: { 
				OR: [
					{ name: 'Current Account' },
					{ name: 'Cash' },
					{ code: '1000' }
				]
			}
		})

		// Calculate cash balance: sum of debits - sum of credits
		let cashBalance = 0
		if (cashAccount) {
			const cashTransactions = await prisma.transaction.findMany({
				where: {
					userId,
					accountId: cashAccount.id
				}
			})

			cashBalance = cashTransactions.reduce((total, txn) => {
				return total + (txn.type === 'debit' ? txn.amount : -txn.amount)
			}, 0)
		}

		// Get today's revenue only
		const today = new Date()
		const year = today.getFullYear()
		const month = today.getMonth()
		const day = today.getDate()
		const startOfDay = new Date(year, month, day, 0, 0, 0, 0)
		const startOfNextDay = new Date(year, month, day + 1, 0, 0, 0, 0)

		// Collect ALL income-type categories (Income, Sales Revenue, etc.)
		const revenueCategories = await prisma.category.findMany({
			where: { type: 'income' }
		})

		let todaysRevenue = 0
		if (revenueCategories.length > 0) {
			const revenueAccounts = await prisma.account.findMany({
				where: { categoryId: { in: revenueCategories.map(c => c.id) } }
			})

			const revenueAccountIds = revenueAccounts.map(acc => acc.id)

			// Revenue accounts are credited when income is earned
			// So we sum credits - debits for revenue accounts, filtered by today's date
			const revenueTransactions = await prisma.transaction.findMany({
				where: {
					userId,
					accountId: { in: revenueAccountIds },
					date: {
						gte: startOfDay,
						lt: startOfNextDay
					}
				}
			})

			todaysRevenue = revenueTransactions.reduce((total, txn) => {
				return total + (txn.type === 'credit' ? txn.amount : -txn.amount)
			}, 0)
		}

		// Get today's expenses - get ALL expense categories, not just one
		const expenseCategories = await prisma.category.findMany({
			where: { type: 'expense' }
		})

		let todaysExpenses = 0
		if (expenseCategories.length > 0) {
			const expenseAccounts = await prisma.account.findMany({
				where: { categoryId: { in: expenseCategories.map(c => c.id) } }
			})

			const expenseAccountIds = expenseAccounts.map(acc => acc.id)

			// Expense accounts are debited when expenses are incurred
			// So we sum debits - credits for expense accounts, filtered by today's date
			const expenseTransactions = await prisma.transaction.findMany({
				where: {
					userId,
					accountId: { in: expenseAccountIds },
					date: {
						gte: startOfDay,
						lt: startOfNextDay
					}
				}
			})

			todaysExpenses = expenseTransactions.reduce((total, txn) => {
				return total + (txn.type === 'debit' ? txn.amount : -txn.amount)
			}, 0)
		}

		const todaysProfit = todaysRevenue - todaysExpenses

		return NextResponse.json({
			cashBalance,
			todaysRevenue,
			todaysExpenses,
			todaysProfit
		})
	} catch (error: any) {
		console.error('Error fetching financial summary:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to fetch financial summary' },
			{ status: 500 }
		)
	}
}

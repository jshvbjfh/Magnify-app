import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

type DateRange = {
	start?: Date
	end?: Date
}

type ReportingContext = NonNullable<Awaited<ReturnType<typeof getRestaurantContextForUser>>>

type ExpenseTransaction = {
	id: string
	date: Date
	amount: number
	type: string
	description: string
	sourceKind: string | null
	account: { name: string } | null
	category: { name: string; type: string } | null
}

type SaleRow = {
	id: string
	saleDate: Date
	dishId: string
	quantitySold: number
	totalSaleAmount: number
	calculatedFoodCost: number
	paymentMethod: string
	dish: { name: string }
}

type ShiftRow = {
	id: string
	date: Date
	calculatedWage: number
}

type WasteRow = {
	id: string
	date: Date
	calculatedCost: number
}

export type SalesProfitRow = {
	id: string
	date: string
	itemName: string
	quantity: number
	unit: string
	unitCost: number
	unitPrice: number
	revenue: number
	cost: number
	profit: number
	profitMargin: string
}

export function isCashEquivalentAccountName(name?: string) {
	const normalized = (name || '').trim().toLowerCase()
	return normalized === 'cash'
		|| normalized.includes('cash')
		|| normalized === 'current account'
		|| normalized.includes('bank')
		|| normalized === 'mobile money'
		|| normalized.includes('momo')
}

export async function requireReportingContext(userId: string): Promise<ReportingContext> {
	const context = await getRestaurantContextForUser(userId)
	if (!context) {
		throw new Error('User not found')
	}

	return context
}

export function buildRestaurantScopeCondition(restaurantId: string | null, fieldName = 'restaurantId') {
	if (!restaurantId) {
		return {}
	}

	return {
		OR: [
			{ [fieldName]: restaurantId },
			{ [fieldName]: null },
		],
	}
}

export function buildBranchScopeCondition(branchId: string | null, fieldName = 'branchId') {
	if (!branchId) {
		return {}
	}

	return {
		[fieldName]: branchId,
	}
}

export function buildDateRangeCondition(fieldName: string, range: DateRange) {
	const condition: { gte?: Date; lte?: Date } = {}

	if (range.start) {
		condition.gte = range.start
	}

	if (range.end) {
		condition.lte = range.end
	}

	if (!condition.gte && !condition.lte) {
		return {}
	}

	return {
		[fieldName]: condition,
	}
}

function toDateKey(date: Date) {
	return date.toISOString().split('T')[0]
}

function toMonthKey(date: Date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function addSeriesEntry(map: Map<string, { revenue: number; expenses: number }>, key: string, revenue: number, expenses: number) {
	const current = map.get(key) ?? { revenue: 0, expenses: 0 }
	current.revenue += revenue
	current.expenses += expenses
	map.set(key, current)
}

function roundCurrency(value: number) {
	return Math.round(value * 100) / 100
}

export async function getOperationalReportMetrics(context: ReportingContext, range: DateRange = {}) {
	const restaurantScope = buildRestaurantScopeCondition(context.restaurantId) as any
	const branchScope = buildBranchScopeCondition(context.branchId) as any
	const [sales, shifts, wasteLogs, expenseTransactions] = await Promise.all([
		prisma.dishSale.findMany({
			where: {
				userId: context.billingUserId,
				...restaurantScope,
				...branchScope,
				...buildDateRangeCondition('saleDate', range),
			},
			select: {
				id: true,
				saleDate: true,
				dishId: true,
				quantitySold: true,
				totalSaleAmount: true,
				calculatedFoodCost: true,
				paymentMethod: true,
				dish: { select: { name: true } },
			},
			orderBy: { saleDate: 'asc' },
		}),
		prisma.shift.findMany({
			where: {
				userId: context.billingUserId,
				...restaurantScope,
				...branchScope,
				...buildDateRangeCondition('date', range),
			},
			select: { id: true, date: true, calculatedWage: true },
			orderBy: { date: 'asc' },
		}),
		prisma.wasteLog.findMany({
			where: {
				userId: context.billingUserId,
				...restaurantScope,
				...branchScope,
				...buildDateRangeCondition('date', range),
			},
			select: { id: true, date: true, calculatedCost: true },
			orderBy: { date: 'asc' },
		}),
		prisma.transaction.findMany({
			where: {
				userId: context.billingUserId,
				...restaurantScope,
				...branchScope,
				...buildDateRangeCondition('date', range),
				category: { is: { type: 'expense' } },
				NOT: [
					{
						description: {
							startsWith: 'COGS - ',
						},
					},
					{
						sourceKind: {
							in: ['inventory_purchase', 'ai_inventory_purchase', 'inventory_waste'],
						},
					},
				],
			},
			select: {
				id: true,
				date: true,
				amount: true,
				type: true,
				description: true,
				sourceKind: true,
				account: { select: { name: true } },
				category: { select: { name: true, type: true } },
			},
			orderBy: { date: 'asc' },
		}),
	])

	const typedSales = sales as SaleRow[]
	const typedShifts = shifts as ShiftRow[]
	const typedWasteLogs = wasteLogs as WasteRow[]
	const typedExpenseTransactions = expenseTransactions as ExpenseTransaction[]

	const revenue = typedSales.reduce((sum, sale) => sum + sale.totalSaleAmount, 0)
	const cogs = typedSales.reduce((sum, sale) => sum + sale.calculatedFoodCost, 0)
	const laborCost = typedShifts.reduce((sum, shift) => sum + shift.calculatedWage, 0)
	const wasteCost = typedWasteLogs.reduce((sum, waste) => sum + waste.calculatedCost, 0)
	const recordedExpenses = typedExpenseTransactions.reduce((sum, txn) => {
		return sum + (txn.type === 'debit' ? txn.amount : -txn.amount)
	}, 0)
	const expenses = cogs + laborCost + recordedExpenses
	const profit = revenue - expenses

	const dailyMap = new Map<string, { revenue: number; expenses: number }>()
	const monthlyMap = new Map<string, { revenue: number; expenses: number }>()

	for (const sale of typedSales) {
		const dayKey = toDateKey(sale.saleDate)
		const monthKey = toMonthKey(sale.saleDate)
		addSeriesEntry(dailyMap, dayKey, sale.totalSaleAmount, sale.calculatedFoodCost)
		addSeriesEntry(monthlyMap, monthKey, sale.totalSaleAmount, sale.calculatedFoodCost)
	}

	for (const shift of typedShifts) {
		const dayKey = toDateKey(shift.date)
		const monthKey = toMonthKey(shift.date)
		addSeriesEntry(dailyMap, dayKey, 0, shift.calculatedWage)
		addSeriesEntry(monthlyMap, monthKey, 0, shift.calculatedWage)
	}

	for (const txn of typedExpenseTransactions) {
		const signedAmount = txn.type === 'debit' ? txn.amount : -txn.amount
		const dayKey = toDateKey(txn.date)
		const monthKey = toMonthKey(txn.date)
		addSeriesEntry(dailyMap, dayKey, 0, signedAmount)
		addSeriesEntry(monthlyMap, monthKey, 0, signedAmount)
	}

	const dailyHistory = Array.from(dailyMap.entries())
		.map(([date, totals]) => ({
			date,
			revenue: roundCurrency(totals.revenue),
			expenses: roundCurrency(totals.expenses),
			profit: roundCurrency(totals.revenue - totals.expenses),
		}))
		.sort((a, b) => a.date.localeCompare(b.date))

	const monthlyHistory = Array.from(monthlyMap.entries())
		.map(([month, totals]) => ({
			month,
			revenue: roundCurrency(totals.revenue),
			expenses: roundCurrency(totals.expenses),
			profit: roundCurrency(totals.revenue - totals.expenses),
		}))
		.sort((a, b) => a.month.localeCompare(b.month))

	const salesWithProfit: SalesProfitRow[] = typedSales
		.slice()
		.sort((a, b) => b.saleDate.getTime() - a.saleDate.getTime())
		.map((sale) => {
			const revenueAmount = sale.totalSaleAmount
			const costAmount = sale.calculatedFoodCost
			const quantity = sale.quantitySold || 0
			const unitCost = quantity > 0 ? costAmount / quantity : 0
			const unitPrice = quantity > 0 ? revenueAmount / quantity : 0
			const profitAmount = revenueAmount - costAmount
			const profitMargin = revenueAmount > 0 ? ((profitAmount / revenueAmount) * 100).toFixed(1) : '0.0'

			return {
				id: sale.id,
				date: sale.saleDate.toISOString(),
				itemName: sale.dish.name,
				quantity,
				unit: 'dish',
				unitCost: roundCurrency(unitCost),
				unitPrice: roundCurrency(unitPrice),
				revenue: roundCurrency(revenueAmount),
				cost: roundCurrency(costAmount),
				profit: roundCurrency(profitAmount),
				profitMargin,
			}
		})

	const recordedExpenseAccounts = typedExpenseTransactions.reduce<Record<string, number>>((acc, txn) => {
		const signedAmount = txn.type === 'debit' ? txn.amount : -txn.amount
		const accountName = txn.account?.name || txn.category?.name || 'Recorded Expense'
		acc[accountName] = (acc[accountName] || 0) + signedAmount
		return acc
	}, {})

	return {
		context,
		sales: typedSales,
		shifts: typedShifts,
		wasteLogs: typedWasteLogs,
		expenseTransactions: typedExpenseTransactions,
		summary: {
			revenue: roundCurrency(revenue),
			cogs: roundCurrency(cogs),
			laborCost: roundCurrency(laborCost),
			wasteCost: roundCurrency(wasteCost),
			recordedExpenses: roundCurrency(recordedExpenses),
			recordedExpenseAccounts: Object.fromEntries(
				Object.entries(recordedExpenseAccounts)
					.map(([name, amount]) => [name, roundCurrency(amount)])
					.filter(([, amount]) => amount !== 0)
			),
			expenses: roundCurrency(expenses),
			profit: roundCurrency(profit),
			salesCount: typedSales.length,
		},
		dailyHistory,
		monthlyHistory,
		salesWithProfit,
	}
}

export function buildOperationalIncomeStatement(metrics: Awaited<ReturnType<typeof getOperationalReportMetrics>>) {
	const expenseAccounts: Record<string, number> = {}

	if (metrics.summary.cogs !== 0) {
		expenseAccounts['Food Cost'] = metrics.summary.cogs
	}

	if (metrics.summary.laborCost !== 0) {
		expenseAccounts['Labor Cost'] = metrics.summary.laborCost
	}

	for (const [name, amount] of Object.entries(metrics.summary.recordedExpenseAccounts)) {
		const numericAmount = Number(amount)
		if (numericAmount !== 0) {
			expenseAccounts[name] = numericAmount
		}
	}

	return {
		income: {
			total: metrics.summary.revenue,
			accounts: metrics.summary.revenue === 0 ? {} : { 'Restaurant Sales': metrics.summary.revenue },
		},
		expenses: {
			total: metrics.summary.expenses,
			accounts: expenseAccounts,
		},
		netProfit: metrics.summary.profit,
	}
}

export async function getScopedCashBalance(context: ReportingContext, endDate?: Date) {
	const restaurantScope = buildRestaurantScopeCondition(context.restaurantId) as any
	const branchScope = buildBranchScopeCondition(context.branchId) as any
	const transactions = await prisma.transaction.findMany({
		where: {
			userId: context.billingUserId,
			...restaurantScope,
			...branchScope,
			...buildDateRangeCondition('date', { end: endDate }),
		},
		select: {
			amount: true,
			type: true,
			account: { select: { name: true } },
		},
	})

	return roundCurrency(transactions.reduce((total, txn) => {
		if (!isCashEquivalentAccountName(txn.account?.name)) {
			return total
		}

		return total + (txn.type === 'debit' ? txn.amount : -txn.amount)
	}, 0))
}
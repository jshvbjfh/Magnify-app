export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { AI_ANALYTICS_DISABLED_MESSAGE, AI_ANALYTICS_ENABLED } from '@/lib/aiAnalyticsFeature'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { generateAnalyticsInsights, type AnalyticsInsights } from '@/lib/openai'

type MonthMetric = {
	month: string
	income: number
	expense: number
	net: number
}

function round2(v: number) {
	return Math.round(v * 100) / 100
}

function monthKey(date: Date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function getDayName(date: Date) {
	const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
	return days[date.getDay()]
}

function median(values: number[]) {
	if (!values.length) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// ─── LAYER 1: BUSINESS PROFILER ──────────────────────────────────────────────
// Reads all transaction signals and builds a deep business understanding
// before any AI is involved. This is deterministic.

function buildBusinessProfile(params: {
	transactions: Array<{
		description: string
		amount: number
		accountName: string
		accountType: string
		categoryType: string
		type: string
		date: Date
		paymentMethod?: string
	}>
	inventoryCount: number
	declaredBusinessType: string | null | undefined
}) {
	const { transactions, inventoryCount, declaredBusinessType } = params

	// Signal keyword banks (ordered by industry specificity)
	const produceKeywords   = ['bell pepper', 'butternut', 'onion', 'grape', 'tomato', 'carrot', 'cabbage', 'spinach', 'avocado', 'mango', 'fruit', 'vegetable', 'produce', 'harvest', 'fresh', 'kg', 'pcs', 'box', 'crate']
	const retailSalePatterns = [
		/^sale:\s+(.+?)\s+\(/i,
		/^cash sale:\s+(.+?)\s+\(/i,
		/^dish sale\s*-\s*(.+?)\s*x\s*([0-9.]+)/i,
	]
	const wholesalePatterns  = [/wholesale/i, /bulk/i, /carton/i, /bags/i, /lounge/i, /restaurant/i, /green lounge/i, /allgreens/i, /hotel/i, /supermarket/i]
	const fleetKeywords      = ['vehicle', 'truck', 'fleet', 'driver', 'mileage', 'tire', 'wheel', 'fuel', 'oil', 'transmission', 'hydraulic', 'accelerator', 'rods', 'pivot', 'basiriri', 'differential', 'stabilizer', 'charoi', 'fleet manager']
	const serviceKeywords    = ['service rendered', 'service revenue', 'service charge', 'consult', 'repair service', 'maintenance service']
	const laborKeywords      = ['driver', 'mileage', 'charoi', 'technician', 'transport driver', 'mileage wage', 'fleet manager', 'payment to deus']

	let produceSignals = 0
	let retailSignals  = 0
	let wholesaleSignals = 0
	let fleetSignals   = 0
	let serviceSignals = 0
	let laborSignals   = 0

	const b2bClients: Set<string> = new Set()
	const productRevenue: Record<string, number> = {}
	const laborExpense: { description: string; amount: number }[] = []
	const vehicleExpense: { description: string; amount: number }[] = []

	let totalTransactionCount = transactions.length
	let b2bRevenueTotal = 0
	let retailRevenueTotal = 0

	for (const tx of transactions) {
		const text = `${tx.description || ''} ${tx.accountName || ''}`.toLowerCase()
		const amount = Number(tx.amount || 0)
		const isRevenue = tx.accountType === 'revenue' || tx.accountName?.toLowerCase().includes('revenue')

		// Produce detection
		if (produceKeywords.some((k) => text.includes(k))) produceSignals++

		// Retail / dish sale detection.
		const retailMatch = retailSalePatterns
			.map((pattern) => (tx.description || '').match(pattern))
			.find(Boolean)
		if (retailMatch) {
			retailSignals++
			const productName = retailMatch[1].trim()
			if (isRevenue) {
				productRevenue[productName] = (productRevenue[productName] || 0) + amount
				retailRevenueTotal += amount
			}
		}

		// Wholesale / B2B client detection
		if (wholesalePatterns.some((p) => p.test(text))) {
			wholesaleSignals++
			// Extract client name if we can
			const clientMatch = text.match(/(green lounge|allgreens|hotel|supermarket|restaurant|lounge)/i)
			if (clientMatch) b2bClients.add(clientMatch[1])
			if (isRevenue) b2bRevenueTotal += amount
		}

		// "Cost of goods sold to [Client]" — wholesale signal
		if (/sold to/i.test(text)) {
			wholesaleSignals += 2
			const soldToMatch = (tx.description || '').match(/sold to (.+?)(?:\s*$)/i)
			if (soldToMatch) b2bClients.add(soldToMatch[1].trim())
			if (isRevenue) b2bRevenueTotal += amount
		}

		// Fleet / vehicle signals
		if (fleetKeywords.some((k) => text.includes(k))) {
			fleetSignals++
			if (!isRevenue && amount > 0) vehicleExpense.push({ description: tx.description, amount })
		}

		// Service revenue
		if (serviceKeywords.some((k) => text.includes(k))) serviceSignals++

		// Labor
		if (laborKeywords.some((k) => text.includes(k))) {
			laborSignals++
			if (!isRevenue && amount > 0) laborExpense.push({ description: tx.description, amount })
		}
	}

	// ── Classify industry ────────────────────────────────────────────────────
	let industry = 'general-trading'
	const hasFleet = fleetSignals >= 3
	const hasProduce = produceSignals >= 3 || retailSignals >= 2
	const hasWholesale = wholesaleSignals >= 2

	if (hasProduce && hasFleet) {
		industry = 'fresh-produce-trading-with-logistics'
	} else if (hasProduce && hasWholesale) {
		industry = 'fresh-produce-wholesale'
	} else if (hasProduce) {
		industry = 'fresh-produce-retail'
	} else if (hasFleet && fleetSignals > serviceSignals) {
		industry = 'transport-logistics'
	} else if (serviceSignals > retailSignals * 1.5) {
		industry = 'services'
	} else if (hasWholesale) {
		industry = 'wholesale-trading'
	}

	// ── Revenue split ────────────────────────────────────────────────────────
	const totalRevenue = retailRevenueTotal + b2bRevenueTotal
	const revenueChannels = {
		retailPercent: totalRevenue ? round2((retailRevenueTotal / totalRevenue) * 100) : 0,
		b2bPercent: totalRevenue ? round2((b2bRevenueTotal / totalRevenue) * 100) : 0,
		b2bClients: [...b2bClients]
	}

	// ── Top products ─────────────────────────────────────────────────────────
	const topProducts = Object.entries(productRevenue)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([name, revenue]) => ({ name, revenue: round2(revenue) }))

	// ── Cost breakdowns ──────────────────────────────────────────────────────
	const totalVehicleCost = vehicleExpense.reduce((a, b) => a + b.amount, 0)
	const totalLaborCost   = laborExpense.reduce((a, b) => a + b.amount, 0)

	const revenueTx = transactions.filter((t) => t.accountType === 'revenue' || t.accountName?.toLowerCase().includes('revenue'))
	const ticketSizes = revenueTx.map((t) => Number(t.amount || 0)).filter((n) => n > 0)
	const avgTicket = ticketSizes.length ? ticketSizes.reduce((a, b) => a + b, 0) / ticketSizes.length : 0

	return {
		declaredBusinessType: declaredBusinessType || 'not set',
		detectedIndustry: industry,
		industryDescription: {
			'fresh-produce-trading-with-logistics': 'Fresh produce trading business (fruits & vegetables) with an owned vehicle fleet for delivery and logistics.',
			'fresh-produce-wholesale': 'Fresh produce wholesale supplier to restaurants, hotels, and retailers.',
			'fresh-produce-retail': 'Fresh produce retail business selling directly to consumers.',
			'transport-logistics': 'Transport and logistics company with managed vehicle fleet.',
			'wholesale-trading': 'Wholesale trading business supplying goods in bulk to business clients.',
			'services': 'Professional services business.',
			'general-trading': 'General trading business.'
		}[industry] || 'General business.',
		revenueChannels,
		topProducts,
		laborInsights: {
			totalLaborCost: round2(totalLaborCost),
			transactions: laborExpense.length,
		},
		fleetInsights: {
			totalVehicleCost: round2(totalVehicleCost),
			transactions: vehicleExpense.length,
			hasFleet
		},
		signals: {
			produceSignals,
			retailSignals,
			wholesaleSignals,
			fleetSignals,
			serviceSignals,
			laborSignals,
			inventoryCount,
			avgTicket: round2(avgTicket),
			totalTransactions: totalTransactionCount
		}
	}
}

// ─── LAYER 2: METRICS ENGINE (deterministic math only) ───────────────────────
function buildMetrics(transactions: any[], inventoryItems: any[]) {
	const monthlyMap: Record<string, MonthMetric> = {}
	const expenseByAccount: Record<string, number> = {}
	const incomeByAccount: Record<string, number> = {}
	const paymentMethods: Record<string, number> = {}
	const weekdayRevenue: Record<string, number> = {
		Sunday: 0, Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0, Saturday: 0
	}

	let totalIncome = 0
	let totalExpense = 0
	let cogsTotal = 0

	for (const t of transactions) {
		const amount = Number(t.amount || 0)
		const accountName = t.account?.name || t.accountName || 'Unknown'
		const accountType = (t.account?.type || '').toLowerCase()
		const categoryType = (t.category?.type || '').toLowerCase()
		const mk = monthKey(new Date(t.date))
		if (!monthlyMap[mk]) monthlyMap[mk] = { month: mk, income: 0, expense: 0, net: 0 }

		const isRevenue = accountType === 'revenue' || categoryType === 'income'
		const isExpense = accountType === 'expense' || categoryType === 'expense'
		const isCOGS = accountName.toLowerCase().includes('cost of goods')

		if (isRevenue) {
			const rev = t.type === 'credit' ? amount : -amount
			if (rev > 0) {
				totalIncome += rev
				monthlyMap[mk].income += rev
				incomeByAccount[accountName] = (incomeByAccount[accountName] || 0) + rev
				weekdayRevenue[getDayName(new Date(t.date))] += rev
			}
		}

		if (isExpense) {
			const exp = t.type === 'debit' ? amount : -amount
			if (exp > 0) {
				totalExpense += exp
				monthlyMap[mk].expense += exp
				expenseByAccount[accountName] = (expenseByAccount[accountName] || 0) + exp
				if (isCOGS) cogsTotal += exp
			}
		}

		monthlyMap[mk].net = monthlyMap[mk].income - monthlyMap[mk].expense
		paymentMethods[t.paymentMethod || 'Unknown'] = (paymentMethods[t.paymentMethod || 'Unknown'] || 0) + 1
	}

	const grossProfit = totalIncome - cogsTotal
	const grossMargin = totalIncome > 0 ? round2((grossProfit / totalIncome) * 100) : 0
	const netProfit = totalIncome - totalExpense
	const netMargin = totalIncome > 0 ? round2((netProfit / totalIncome) * 100) : 0

	const monthlyTrend = Object.values(monthlyMap)
		.sort((a, b) => a.month.localeCompare(b.month))
		.slice(-12)
		.map((m) => ({ ...m, income: round2(m.income), expense: round2(m.expense), net: round2(m.net) }))

	// Month-over-month change (last 2 months)
	let momNetChange: number | null = null
	let momNetChangePercent: number | null = null
	if (monthlyTrend.length >= 2) {
		const prev = monthlyTrend[monthlyTrend.length - 2].net
		const curr = monthlyTrend[monthlyTrend.length - 1].net
		momNetChange = round2(curr - prev)
		momNetChangePercent = prev !== 0 ? round2(((curr - prev) / Math.abs(prev)) * 100) : null
	}

	const topExpenseAccounts = Object.entries(expenseByAccount)
		.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8)
		.map(([name, amount]) => ({ name, amount: round2(amount) }))

	const topIncomeAccounts = Object.entries(incomeByAccount)
		.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8)
		.map(([name, amount]) => ({ name, amount: round2(amount) }))

	const paymentMethodMix = Object.entries(paymentMethods)
		.sort((a, b) => b[1] - a[1])
		.map(([name, count]) => ({ name, count }))

	const inventorySnapshot = inventoryItems.slice(0, 20).map((item: any) => ({
		name: item.name,
		unit: item.unit,
		quantity: Number(item.quantity || 0),
		unitCost: Number(item.unitCost || 0),
		unitPrice: Number(item.unitPrice || 0),
		margin: Number(item.unitCost || 0) > 0
			? round2(((Number(item.unitPrice || 0) - Number(item.unitCost || 0)) / Number(item.unitCost || 0)) * 100)
			: null,
		estimatedValue: round2(Number(item.quantity || 0) * Number(item.unitCost || 0))
	}))

	// Detect spending spikes (account with >30% of total expense)
	const spendingAlerts = topExpenseAccounts
		.filter((a) => totalExpense > 0 && (a.amount / totalExpense) > 0.3)
		.map((a) => `${a.name} represents ${round2((a.amount / totalExpense) * 100)}% of total expenses`)

	return {
		summary: {
			totalTransactions: transactions.length,
			totalIncome: round2(totalIncome),
			totalExpense: round2(totalExpense),
			cogsTotal: round2(cogsTotal),
			grossProfit: round2(grossProfit),
			grossMargin,
			netProfit: round2(netProfit),
			netMargin,
			inventoryItems: inventoryItems.length,
			momNetChange,
			momNetChangePercent,
		},
		monthlyTrend,
		topExpenseAccounts,
		topIncomeAccounts,
		paymentMethodMix,
		weekdayRevenue: Object.entries(weekdayRevenue).map(([day, revenue]) => ({ day, revenue: round2(revenue) })),
		inventorySnapshot,
		spendingAlerts
	}
}

function buildFallbackAnalyticsInsights(dataset: any): AnalyticsInsights {
	const summary = dataset.summary || {}
	const businessProfile = dataset.businessProfile || {}
	const topExpenseAccounts = Array.isArray(dataset.topExpenseAccounts) ? dataset.topExpenseAccounts : []
	const topIncomeAccounts = Array.isArray(dataset.topIncomeAccounts) ? dataset.topIncomeAccounts : []
	const monthlyTrend = Array.isArray(dataset.monthlyTrend) ? dataset.monthlyTrend : []
	const paymentMethodMix = Array.isArray(dataset.paymentMethodMix) ? dataset.paymentMethodMix : []
	const spendingAlerts = Array.isArray(dataset.spendingAlerts) ? dataset.spendingAlerts : []

	const netProfit = Number(summary.netProfit || 0)
	const topIncome = topIncomeAccounts[0]
	const topExpense = topExpenseAccounts[0]
	const latestMonth = monthlyTrend[monthlyTrend.length - 1]

	const comments = [
		`Gemini quota is exhausted right now, so these insights are generated from your saved accounting metrics only.`,
		`Total income is ${Number(summary.totalIncome || 0).toLocaleString()} RWF, while total expenses are ${Number(summary.totalExpense || 0).toLocaleString()} RWF.`,
		`The business is currently reporting a ${netProfit >= 0 ? 'net profit' : 'net loss'} of ${Math.abs(netProfit).toLocaleString()} RWF with a net margin of ${Number(summary.netMargin || 0).toLocaleString()}%.`,
	]

	if (topIncome) {
		comments.push(`${topIncome.name} is the strongest income account at ${Number(topIncome.amount || 0).toLocaleString()} RWF.`)
	}
	if (topExpense) {
		comments.push(`${topExpense.name} is the largest expense account at ${Number(topExpense.amount || 0).toLocaleString()} RWF.`)
	}
	if (latestMonth) {
		comments.push(`For ${latestMonth.month}, net performance was ${Number(latestMonth.net || 0).toLocaleString()} RWF.`)
	}
	if (spendingAlerts[0]) {
		comments.push(String(spendingAlerts[0]))
	}

	const advice = [
		`Watch ${topExpense?.name || 'your largest expense accounts'} closely and compare it against sales each week.`,
		`Protect cash flow by reviewing payment method mix and reconciling the most-used channel daily.`,
		`Retry AI analytics later when Gemini quota resets if you want narrative analysis beyond these verified metrics.`,
	]

	return {
		headline: `Analytics ready from your ledger: ${netProfit >= 0 ? 'profit' : 'loss'} stands at ${Math.abs(netProfit).toLocaleString()} RWF${businessProfile.detectedIndustry ? ` for your ${String(businessProfile.detectedIndustry).replaceAll('-', ' ')}` : ''}.`,
		comments: comments.slice(0, 8),
		advice: advice.slice(0, 6),
		charts: [
			{
				title: 'Monthly Net Trend',
				type: 'line',
				xKey: 'month',
				yKey: 'net',
				data: monthlyTrend.slice(-12).map((row: any) => ({ month: row.month, net: Number(row.net || 0) })),
				note: 'Tracks whether the business is improving or weakening month by month.',
			},
			{
				title: 'Top Expense Accounts',
				type: 'bar',
				xKey: 'name',
				yKey: 'amount',
				data: topExpenseAccounts.slice(0, 8).map((row: any) => ({ name: String(row.name || 'Unknown'), amount: Number(row.amount || 0) })),
				note: 'Highlights where the biggest cost pressure is coming from.',
			},
		],
		tables: [
			{
				title: 'Revenue Leaders',
				columns: ['Account', 'Amount (RWF)'],
				rows: topIncomeAccounts.slice(0, 8).map((row: any) => [String(row.name || 'Unknown'), Number(row.amount || 0)]),
			},
			{
				title: 'Payment Method Mix',
				columns: ['Method', 'Count'],
				rows: paymentMethodMix.slice(0, 8).map((row: any) => [String(row.name || 'Unknown'), Number(row.count || 0)]),
			},
		],
	}
}

// ─── ROUTE HANDLER ──────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
	try {
		if (!AI_ANALYTICS_ENABLED) {
			return NextResponse.json({ error: AI_ANALYTICS_DISABLED_MESSAGE, archived: true }, { status: 503 })
		}

		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const context = await getRestaurantContextForUser(session.user.id)
		const billingUserId = context?.billingUserId ?? session.user.id

		const user = await prisma.user.findUnique({
			where: { id: billingUserId },
			select: { businessType: true }
		})

		const searchParams = req.nextUrl.searchParams
		const saveSnapshot = searchParams.get('saveSnapshot') !== 'false'

		const [transactions, inventoryItems] = await Promise.all([
			prisma.transaction.findMany({
				where: { userId: billingUserId },
				include: { account: true, category: true },
				orderBy: { date: 'desc' }
			}),
			prisma.inventoryItem.findMany({ where: { userId: billingUserId } })
		])

		// Layer 1: Deep business understanding from transaction signals
		const simplifiedTransactions = transactions.map((t) => ({
			description: t.description || '',
			amount: Number(t.amount || 0),
			accountName: t.account?.name || t.accountName || 'Unknown',
			accountType: (t.account?.type || '').toLowerCase(),
			categoryType: (t.category?.type || '').toLowerCase(),
			type: t.type,
			date: new Date(t.date),
			paymentMethod: t.paymentMethod || undefined
		}))

		const businessProfile = buildBusinessProfile({
			transactions: simplifiedTransactions,
			inventoryCount: inventoryItems.length,
			declaredBusinessType: user?.businessType
		})

		// Layer 2: Deterministic metrics engine
		const metrics = buildMetrics(transactions, inventoryItems)

		// Layer 3: Feed structured dataset to AI for interpretation
		// Give AI FULL access: every transaction with description, amount, account, category, date
		const fullTransactionLedger = transactions.map((t) => ({
			date: new Date(t.date).toISOString().slice(0, 10),
			description: t.description || '',
			amount: Number(t.amount || 0),
			type: t.type,
			account: t.account?.name || t.accountName || 'Unknown',
			accountType: (t.account?.type || '').toLowerCase(),
			category: t.category?.name || '',
			categoryType: (t.category?.type || '').toLowerCase(),
			paymentMethod: t.paymentMethod || ''
		}))

		const fullInventory = inventoryItems.map((item) => ({
			name: item.name,
			unit: item.unit,
			quantity: Number(item.quantity || 0),
			unitCost: Number(item.unitCost || 0),
			unitPrice: Number(item.unitPrice || 0),
			category: item.category || ''
		}))

		const dataset = {
			businessProfile,
			summary: metrics.summary,
			monthlyTrend: metrics.monthlyTrend,
			topExpenseAccounts: metrics.topExpenseAccounts,
			topIncomeAccounts: metrics.topIncomeAccounts,
			paymentMethodMix: metrics.paymentMethodMix,
			weekdayRevenue: metrics.weekdayRevenue,
			inventorySnapshot: metrics.inventorySnapshot,
			spendingAlerts: metrics.spendingAlerts,
			fullTransactionLedger,
			fullInventory
		}

		let ai: AnalyticsInsights
		let quotaLimited = false
		let quotaMessage: string | null = null
		try {
			ai = await generateAnalyticsInsights(dataset)
		} catch (error: any) {
			if (String(error?.message || '').includes('GEMINI_DAILY_LIMIT_REACHED')) {
				quotaLimited = true
				quotaMessage = 'Jesse AI analytics is temporarily using fallback insights because Jesse AI is currently unavailable due to service limits.'
				ai = buildFallbackAnalyticsInsights(dataset)
			} else {
				throw error
			}
		}

		// Layer 4: Persist daily snapshot
		let snapshotSaved = false
		if (saveSnapshot) {
			const now = new Date()
			const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
			const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
			const snapshotType = `ai_daily_insight_${session.user.id}`
			const snapshotData = JSON.stringify({
				userId: session.user.id,
				generatedAt: now.toISOString(),
				businessProfile: dataset.businessProfile,
				summary: dataset.summary,
				ai
			})

			const existing = await prisma.financialStatement.findFirst({
				where: { type: snapshotType, periodStart: { gte: dayStart, lte: dayEnd } },
				orderBy: { createdAt: 'desc' }
			})

			if (existing) {
				await prisma.financialStatement.update({ where: { id: existing.id }, data: { data: snapshotData } })
			} else {
				await prisma.financialStatement.create({
					data: { type: snapshotType, periodStart: dayStart, periodEnd: dayEnd, data: snapshotData }
				})
			}
			snapshotSaved = true
		}

		return NextResponse.json({ generatedAt: new Date().toISOString(), dataset, ai, snapshotSaved, quotaLimited, quotaMessage })
	} catch (error: any) {
		console.error('AI analytics error:', error)
		return NextResponse.json({ error: error.message || 'Failed to generate Jesse AI analytics' }, { status: 500 })
	}
}

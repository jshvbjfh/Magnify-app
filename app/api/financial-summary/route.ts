export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { getOperationalReportMetrics, getScopedCashBalance, requireReportingContext } from '@/lib/restaurantReporting'

export async function GET() {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return new NextResponse('Unauthorized', { status: 401 })
		}

		const reportingContext = await requireReportingContext(session.user.id)

		const todayKigali = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date())
		const startOfDay = new Date(`${todayKigali}T00:00:00+02:00`)
		const endOfDay = new Date(`${todayKigali}T23:59:59.999+02:00`)
		const [metrics, cashBalance] = await Promise.all([
			getOperationalReportMetrics(reportingContext, { start: startOfDay, end: endOfDay }),
			getScopedCashBalance(reportingContext),
		])

		return NextResponse.json({
			cashBalance,
			todaysRevenue: metrics.summary.revenue,
			todaysExpenses: metrics.summary.expenses,
			todaysProfit: metrics.summary.profit
		})
	} catch (error: any) {
		console.error('Error fetching financial summary:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to fetch financial summary' },
			{ status: 500 }
		)
	}
}

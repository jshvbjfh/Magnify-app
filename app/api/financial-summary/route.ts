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

		const today = new Date()
		const year = today.getFullYear()
		const month = today.getMonth()
		const day = today.getDate()
		const startOfDay = new Date(year, month, day, 0, 0, 0, 0)
		const startOfNextDay = new Date(year, month, day + 1, 0, 0, 0, 0)
		const [metrics, cashBalance] = await Promise.all([
			getOperationalReportMetrics(reportingContext, { start: startOfDay, end: new Date(startOfNextDay.getTime() - 1) }),
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

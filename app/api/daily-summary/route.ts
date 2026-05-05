export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getOperationalReportMetrics, getScopedCashBalance, requireReportingContext } from '@/lib/restaurantReporting'

export async function GET(request: Request) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return new NextResponse('Unauthorized', { status: 401 })
		}

		const reportingContext = await requireReportingContext(session.user.id)

		const { searchParams } = new URL(request.url)
		const dateParam = searchParams.get('date')

		if (!dateParam) {
			return new NextResponse('Date parameter required', { status: 400 })
		}

		// Parse as Kigali midnight so the query covers the full local calendar day
		const startOfDay = new Date(dateParam + 'T00:00:00+02:00')
		const endOfDay = new Date(dateParam + 'T23:59:59.999+02:00')

		const [metrics, cashBalance] = await Promise.all([
			getOperationalReportMetrics(reportingContext, { start: startOfDay, end: endOfDay }),
			getScopedCashBalance(reportingContext, endOfDay),
		])

		return NextResponse.json({
			date: dateParam,
			revenue: metrics.summary.revenue,
			expenses: metrics.summary.expenses,
			profit: metrics.summary.profit,
			cashBalance
		})
	} catch (error) {
		console.error('Error fetching daily summary:', error)
		return new NextResponse('Internal Server Error', { status: 500 })
	}
}

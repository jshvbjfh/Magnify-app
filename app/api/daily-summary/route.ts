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

		// Parse the date and set time to start and end of day
		const selectedDate = new Date(dateParam)
		const startOfDay = new Date(selectedDate.setHours(0, 0, 0, 0))
		const endOfDay = new Date(selectedDate.setHours(23, 59, 59, 999))

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

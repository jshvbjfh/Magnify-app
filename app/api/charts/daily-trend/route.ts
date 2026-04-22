export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getOperationalReportMetrics, requireReportingContext } from '@/lib/restaurantReporting'

export async function GET() {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return new NextResponse('Unauthorized', { status: 401 })
		}

		// Start date: January 4, 2026
		const startDate = new Date('2026-01-04T00:00:00')
		const reportingContext = await requireReportingContext(session.user.id)
		const metrics = await getOperationalReportMetrics(reportingContext, { start: startDate })

		const result = metrics.dailyHistory.map((entry) => ({
			date: entry.date,
			revenue: entry.revenue,
			expenses: entry.expenses,
			profit: entry.profit,
		}))

		return NextResponse.json(result)
	} catch (error) {
		console.error('Error fetching daily trend:', error)
		return new NextResponse('Internal Server Error', { status: 500 })
	}
}

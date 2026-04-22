export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { getOperationalReportMetrics, requireReportingContext } from '@/lib/restaurantReporting'

export async function GET() {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return new NextResponse('Unauthorized', { status: 401 })
		}

		const reportingContext = await requireReportingContext(session.user.id)
		const metrics = await getOperationalReportMetrics(reportingContext)

		const chartData = metrics.monthlyHistory.map((entry) => ({
			month: entry.month,
			revenue: entry.revenue,
			expenses: entry.expenses,
			profit: entry.profit,
		}))

		return NextResponse.json(chartData)
	} catch (error: any) {
		console.error('Error fetching profitability data:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to fetch profitability data' },
			{ status: 500 }
		)
	}
}

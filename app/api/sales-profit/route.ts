export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { getOperationalReportMetrics, requireReportingContext } from '@/lib/restaurantReporting'

export async function GET(request: Request) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const { searchParams } = new URL(request.url)
		const start = searchParams.get('start')
		const end = searchParams.get('end')

		if (!start || !end) {
			return NextResponse.json({ error: 'Start and end dates required' }, { status: 400 })
		}

		const reportingContext = await requireReportingContext(session.user.id)
		const metrics = await getOperationalReportMetrics(reportingContext, {
			start: new Date(start + 'T00:00:00'),
			end: new Date(end + 'T23:59:59'),
		})

		return NextResponse.json({ sales: metrics.salesWithProfit })
	} catch (error: any) {
		console.error('Sales profit error:', error)
		return NextResponse.json(
			{ error: 'Failed to fetch sales data', details: error.message },
			{ status: 500 }
		)
	}
}

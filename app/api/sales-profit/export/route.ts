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

		const salesWithProfit = metrics.salesWithProfit.map((sale) => {
			const date = new Date(sale.date)
			const formattedDate = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`

			return {
				date: formattedDate,
				itemName: sale.itemName,
				quantity: sale.quantity,
				unit: sale.unit,
				unitCost: sale.unitCost,
				unitPrice: sale.unitPrice,
				revenue: sale.revenue,
				cost: sale.cost,
				profit: sale.profit,
				profitMargin: sale.profitMargin,
			}
		})

	// Create CSV content
	const headers = [
		'Date',
		'Product',
		'Quantity',
		'Unit',
		'Unit Cost (RWF)',
		'Unit Price (RWF)',
		'Revenue (RWF)',
		'Cost (RWF)',
		'Profit (RWF)',
		'Profit Margin (%)'
	]

	const csvRows = [
		headers.join(','),
		...salesWithProfit.map((sale: any) => [
			sale.date,
			`"${sale.itemName}"`,
			sale.quantity,
			sale.unit,
			sale.unitCost,
			sale.unitPrice,
			sale.revenue,
			sale.cost,
			sale.profit,
			sale.profitMargin
		].join(','))
	]

	// Add summary row
	const totalRevenue = salesWithProfit.reduce((sum: number, s: any) => sum + s.revenue, 0)
	const totalCost = salesWithProfit.reduce((sum: number, s: any) => sum + s.cost, 0)
	const totalProfit = salesWithProfit.reduce((sum: number, s: any) => sum + s.profit, 0)
	const avgMargin = salesWithProfit.length > 0 
		? (salesWithProfit.reduce((sum: number, s: any) => sum + parseFloat(s.profitMargin), 0) / salesWithProfit.length).toFixed(2)
		: '0'
	csvRows.push('')
	csvRows.push(`"SUMMARY",,,,,,${totalRevenue},${totalCost},${totalProfit},${avgMargin}`)
		csvRows.push(`"Period: ${start} to ${end}"`)

		const csv = csvRows.join('\n')

		return new NextResponse(csv, {
			headers: {
				'Content-Type': 'application/vnd.ms-excel',
				'Content-Disposition': `attachment; filename="sales-profit-${start}-to-${end}.csv"`
			}
		})
	} catch (error: any) {
		console.error('Export error:', error)
		return NextResponse.json(
			{ error: 'Failed to export sales data', details: error.message },
			{ status: 500 }
		)
	}
}

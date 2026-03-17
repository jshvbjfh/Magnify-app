export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

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

		// Fetch all sales transactions in the date range
		const transactions = await prisma.transaction.findMany({
			where: {
				userId: session.user.id,
				date: {
					gte: new Date(start),
					lte: new Date(end + 'T23:59:59')
				},
				type: 'credit',
				account: {
					name: 'Sales Revenue'
				}
			},
			include: {
				account: true
			},
			orderBy: {
				date: 'desc'
			}
		})

		// Get all inventory items for the user
		const inventoryItems = await prisma.inventoryItem.findMany({
			where: {
				userId: session.user.id
			}
		})

		// Create a map for quick lookup
		const itemMap = new Map(inventoryItems.map((item: any) => [item.name.toLowerCase(), item]))

		// Process sales and calculate profits
		const salesWithProfit = transactions.map((txn: any) => {
			// Extract item name from description (e.g., "Sale: Diesel (50 kg)")
			const match = txn.description.match(/Sale:\s*(.+?)\s*\(([0-9.]+)\s*(.+?)\)/)
			
			if (!match) {
				return null
			}

			const itemName = match[1].trim()
			const quantity = parseFloat(match[2])
			const unit = match[3].trim()

			// Find inventory item
			const inventoryItem = itemMap.get(itemName.toLowerCase())
			
			if (!inventoryItem) {
				return null
			}

			const revenue = txn.amount
			const unitPrice = (inventoryItem as any).unitPrice || (revenue / quantity)
			const unitCost = (inventoryItem as any).unitCost || 0
			const cost = unitCost * quantity
			const profit = revenue - cost
			const profitMargin = revenue > 0 ? (profit / revenue * 100) : 0

		// Format date as DD/MM/YYYY for Excel
		const date = new Date(txn.date)
		const formattedDate = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`

		return {
			date: formattedDate,
				profit,
				profitMargin: profitMargin.toFixed(2)
			}
	}).filter((sale: any) => sale !== null) as any[]

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

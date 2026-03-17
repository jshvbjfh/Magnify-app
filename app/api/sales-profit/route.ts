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
		// Include both 'Sales Revenue' (general) and 'Restaurant Sales' (dish sales)
		const transactions = await prisma.transaction.findMany({
			where: {
				userId: session.user.id,
				date: {
					gte: new Date(start),
					lte: new Date(end + 'T23:59:59')
				},
				type: 'credit',
				account: {
					OR: [
						{ name: 'Sales Revenue' },
						{ name: 'Restaurant Sales' },
						{ type: 'revenue' }
					]
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

			return {
				id: txn.id,
				date: txn.date.toISOString(),
				itemName,
				quantity,
				unit,
				unitCost,
				unitPrice,
				revenue,
				cost,
				profit,
				profitMargin
			}
		}).filter((sale: any) => sale !== null)

		return NextResponse.json({ sales: salesWithProfit })
	} catch (error: any) {
		console.error('Sales profit error:', error)
		return NextResponse.json(
			{ error: 'Failed to fetch sales data', details: error.message },
			{ status: 500 }
		)
	}
}

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { recordJournalEntry } from '@/lib/accounting'
import { prisma } from '@/lib/prisma'
import { ensureRestaurantForOwner } from '@/lib/restaurantAccess'

export async function GET(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const restaurant = await ensureRestaurantForOwner(session.user.id)

		// Get Accounts Payable account - specifically the main one
		const apAccount = await prisma.account.findFirst({
			where: {
				restaurantId: restaurant.id,
				name: 'Accounts Payable'
			}
		})

		if (!apAccount) {
			return NextResponse.json({
				payables: [],
				totalUnpaid: 0
			})
		}

		// Get all credit transactions (liabilities/what we owe) to Accounts Payable
		// Credit to AP = we owe money
		const creditTransactions = await prisma.transaction.findMany({
			where: {
				userId: session.user.id,
				restaurantId: restaurant.id,
				accountId: apAccount.id,
				type: 'credit'
			},
			orderBy: { date: 'desc' }
		})

		// Get all debit transactions (payments) to Accounts Payable
		// Debit to AP = paying off what we owe
		const debitTransactions = await prisma.transaction.findMany({
			where: {
				userId: session.user.id,
				restaurantId: restaurant.id,
				accountId: apAccount.id,
				type: 'debit'
			}
		})

		// Group by vendor name (extracted from description)
		const payablesByVendor: { [key: string]: { credits: any[], debits: any[] } } = {}

		creditTransactions.forEach(tx => {
			const vendorName = extractVendorName(tx.description)
			if (!payablesByVendor[vendorName]) {
				payablesByVendor[vendorName] = { credits: [], debits: [] }
			}
			payablesByVendor[vendorName].credits.push(tx)
		})

		debitTransactions.forEach(tx => {
			const vendorName = extractVendorName(tx.description)
			if (!payablesByVendor[vendorName]) {
				payablesByVendor[vendorName] = { credits: [], debits: [] }
			}
			payablesByVendor[vendorName].debits.push(tx)
		})

		// Calculate payables with aging
		const payables = Object.entries(payablesByVendor).map(([vendorName, txs]) => {
			const totalAmount = txs.credits.reduce((sum, tx) => sum + tx.amount, 0)
			const paidAmount = txs.debits.reduce((sum, tx) => sum + tx.amount, 0)
			const balance = totalAmount - paidAmount

			// Only include if there's an outstanding balance
			if (balance <= 0) return null

			const oldestCredit = txs.credits.sort((a, b) => 
				new Date(a.date).getTime() - new Date(b.date).getTime()
			)[0]

			const daysOutstanding = Math.floor(
				(new Date().getTime() - new Date(oldestCredit.date).getTime()) / (1000 * 60 * 60 * 24)
			)

			let agingCategory = 'Current'
			if (daysOutstanding > 60) agingCategory = '60+ days'
			else if (daysOutstanding > 30) agingCategory = '31-60 days'
			else if (daysOutstanding > 0) agingCategory = '1-30 days'

			return {
				id: oldestCredit.id,
				date: oldestCredit.date.toISOString(),
				description: oldestCredit.description,
				vendorName,
				totalAmount,
				paidAmount,
				balance,
				daysOutstanding,
				agingCategory
			}
		}).filter(Boolean)

		const totalUnpaid = payables.reduce((sum, p) => sum + (p?.balance || 0), 0)

		return NextResponse.json({
			payables: payables.filter(p => p !== null),
			totalUnpaid
		})
	} catch (error: any) {
		console.error('Error fetching accounts payable:', error)
		return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
	}
}

export async function POST(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const { vendorName, description, amount, date } = await req.json()

		// Be specific about what's missing
		const missingFields = []
		if (!vendorName) missingFields.push('vendorName')
		if (!amount) missingFields.push('amount')
		
		if (missingFields.length > 0) {
			return NextResponse.json({ error: `Missing required fields: ${missingFields.join(', ')}` }, { status: 400 })
		}

		const restaurant = await ensureRestaurantForOwner(session.user.id)
		const txDate = date ? new Date(date) : new Date()
		const fullDescription = `${description || 'Goods/services received'} - ${vendorName}`

		await recordJournalEntry(prisma, {
			userId: session.user.id,
			restaurantId: restaurant.id,
			date: txDate,
			description: fullDescription,
			amount: parseFloat(amount),
			direction: 'out',
			accountName: 'General Expense',
			paymentMethod: 'Credit',
			isManual: true,
			sourceKind: 'accounts_payable',
			authoritativeForRevenue: false,
		})

		return NextResponse.json({ success: true })
	} catch (error: any) {
		console.error('Error creating accounts payable:', error)
		return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
	}
}

function extractVendorName(description: string): string {
	// Try to extract vendor name from description
	// Look for patterns like "Description - VendorName" or "VendorName - Description"
	const parts = description.split(' - ')
	if (parts.length > 1) {
		// Return the last part as vendor name (or first if it looks like a name)
		const lastPart = parts[parts.length - 1].trim()
		return lastPart || 'Unknown Vendor'
	}
	
	// Look for common keywords
	const lowerDesc = description.toLowerCase()
	if (lowerDesc.includes('dad')) return 'Dad'
	if (lowerDesc.includes('owner') && lowerDesc.includes('momo')) return 'Owner (Personal Momo)'
	if (lowerDesc.includes('charoi')) return 'Charoi'
	if (lowerDesc.includes('driver')) return 'Driver'
	if (lowerDesc.includes('zcss')) return 'ZCSS'
	
	return 'Unknown Vendor'
}

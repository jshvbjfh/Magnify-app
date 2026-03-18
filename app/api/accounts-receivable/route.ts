import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

async function requireUserId() {
	const session = await getServerSession(authOptions)
	const userId = session?.user?.id
	if (!userId) throw new Error('Unauthorized')
	return userId
}

// GET: Retrieve all unpaid services (Accounts Receivable)
export async function GET() {
	try {
		const userId = await requireUserId()

		// Find the Accounts Receivable account
		const arAccount = await prisma.account.findFirst({
			where: { 
				OR: [
					{ code: '1200' },
					{ name: { contains: 'Accounts Receivable' } },
					{ name: { contains: 'Receivable' } }
				]
			}
		})

		if (!arAccount) {
			return NextResponse.json({
				receivables: [],
				totalUnpaid: 0,
				message: 'Accounts Receivable account not found. Will be created when you add your first unpaid service.'
			})
		}

		// Get all AR transactions (debits increase AR, credits decrease AR)
		const arTransactions = await prisma.transaction.findMany({
			where: {
				userId,
				accountId: arAccount.id
			},
			orderBy: { date: 'desc' },
			include: {
				account: true,
				category: true
			}
		})

		// Group by pairId to show receivable entries with their status
		const receivableGroups = new Map<string, {
			pairId: string
			date: Date
			description: string
			customerName: string
			totalAmount: number
			paidAmount: number
			balance: number
			isPaid: boolean
			transactions: any[]
		}>()

		for (const tx of arTransactions) {
			if (!tx.pairId) continue
			
			if (!receivableGroups.has(tx.pairId)) {
				receivableGroups.set(tx.pairId, {
					pairId: tx.pairId,
					date: tx.date,
					description: tx.description,
					customerName: extractCustomerName(tx.description),
					totalAmount: 0,
					paidAmount: 0,
					balance: 0,
					isPaid: false,
					transactions: []
				})
			}

			const group = receivableGroups.get(tx.pairId)!
			group.transactions.push(tx)

			// Debit to AR = amount owed (increases receivable)
			// Credit to AR = payment received (decreases receivable)
			if (tx.type === 'debit') {
				group.totalAmount += tx.amount
			} else {
				group.paidAmount += tx.amount
			}
		}

		// Calculate balances and filter unpaid
		const receivables = Array.from(receivableGroups.values()).map(group => {
			group.balance = group.totalAmount - group.paidAmount
			group.isPaid = group.balance <= 0
			
			// Calculate days outstanding
			const daysOutstanding = Math.floor((Date.now() - group.date.getTime()) / (1000 * 60 * 60 * 24))
			
			return {
				id: group.pairId,
				date: group.date.toISOString(),
				description: group.description,
				customerName: group.customerName,
				totalAmount: group.totalAmount,
				paidAmount: group.paidAmount,
				balance: group.balance,
				isPaid: group.isPaid,
				daysOutstanding,
				agingCategory: daysOutstanding <= 30 ? 'Current' : 
				               daysOutstanding <= 60 ? '31-60 days' :
				               daysOutstanding <= 90 ? '61-90 days' : 'Over 90 days'
			}
		})

		// Separate paid and unpaid
		const unpaidReceivables = receivables.filter(r => !r.isPaid).sort((a, b) => 
			new Date(a.date).getTime() - new Date(b.date).getTime()
		)
		
		const totalUnpaid = unpaidReceivables.reduce((sum, r) => sum + r.balance, 0)

		return NextResponse.json({
			receivables: unpaidReceivables,
			totalUnpaid,
			count: unpaidReceivables.length
		})
	} catch (e: any) {
		console.error('Error fetching accounts receivable:', e)
		return new NextResponse(e?.message || 'Unauthorized', { status: 401 })
	}
}

// POST: Record a new unpaid service
export async function POST(req: Request) {
	try {
		const userId = await requireUserId()
		const body = await req.json()

		const amount = parseFloat(String(body.amount || 0))
		if (!Number.isFinite(amount) || amount <= 0) {
			return new NextResponse('Invalid amount', { status: 400 })
		}

		const customerName = String(body.customerName || 'Customer').trim()
		const serviceDescription = String(body.description || 'Service provided').trim()
		const date = body.date ? new Date(body.date) : new Date()

		// Ensure core categories exist
		const assetCategory = await prisma.category.upsert({
			where: { restaurantId_name: { restaurantId: null, name: 'Asset' } },
			update: { type: 'asset' },
			create: { restaurantId: null, name: 'Asset', type: 'asset' }
		})

		const incomeCategory = await prisma.category.upsert({
			where: { restaurantId_name: { restaurantId: null, name: 'Income' } },
			update: { type: 'income' },
			create: { restaurantId: null, name: 'Income', type: 'income' }
		})

		// Ensure Accounts Receivable account exists
		let arAccount = await prisma.account.findFirst({
			where: { code: '1200' }
		})

		if (!arAccount) {
			arAccount = await prisma.account.create({
				data: {
					code: '1200',
					name: 'Accounts Receivable',
					type: 'asset',
					categoryId: assetCategory.id,
					description: 'Money owed to us for services provided but not yet paid'
				}
			})
		}

		// Ensure Service Revenue account exists
		let revenueAccount = await prisma.account.findFirst({
			where: { 
				OR: [
					{ name: { contains: 'Service Revenue' } },
					{ name: { contains: 'Sales' } }
				]
			}
		})

		if (!revenueAccount) {
			revenueAccount = await prisma.account.create({
				data: {
					code: '4000',
					name: 'Service Revenue',
					type: 'revenue',
					categoryId: incomeCategory.id,
					description: 'Revenue from services provided'
				}
			})
		}

		const description = `Unpaid service - ${customerName}: ${serviceDescription}`
		const pairId = `ar-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`

		// Double-entry bookkeeping:
		// Debit Accounts Receivable (Asset increases)
		// Credit Service Revenue (Income increases)
		await prisma.transaction.createMany({
			data: [
				{
					userId,
					accountId: arAccount.id,
					categoryId: assetCategory.id,
					date,
					description,
					amount,
					type: 'debit',
					isManual: true,
					paymentMethod: 'Accounts Receivable',
					pairId
				},
				{
					userId,
					accountId: revenueAccount.id,
					categoryId: incomeCategory.id,
					date,
					description,
					amount,
					type: 'credit',
					isManual: true,
					paymentMethod: 'Accounts Receivable',
					pairId
				}
			]
		})

		return NextResponse.json({
			success: true,
			message: `Recorded unpaid service for ${customerName}: ${amount} RWF`,
			pairId
		})
	} catch (e: any) {
		console.error('Error creating receivable:', e)
		return new NextResponse(e?.message || 'Error creating receivable', { status: 500 })
	}
}

// Helper function to extract customer name from description
function extractCustomerName(description: string): string {
	// Try to extract customer name from description
	// Format: "Unpaid service - CustomerName: description"
	const match = description.match(/Unpaid service - ([^:]+):/)
	if (match) return match[1].trim()
	
	// Alternative format: "Outstanding balance for..."
	const match2 = description.match(/Outstanding balance for (.+)/i)
	if (match2) return match2[1].trim()
	
	return 'Customer'
}

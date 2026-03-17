export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { generateFinancialReportPDF } from '@/lib/pdfGenerator'

export async function GET(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user) {
			return new NextResponse('Unauthorized', { status: 401 })
		}

		// Get query parameters
		const searchParams = req.nextUrl.searchParams
		const startDate = searchParams.get('startDate')
		const endDate = searchParams.get('endDate')

		// Build where clause for date filtering
		let dateFilter = {}
		if (startDate && endDate) {
			dateFilter = {
				date: {
					gte: new Date(startDate + 'T00:00:00'),
					lte: new Date(endDate + 'T23:59:59')
				}
			}
		}

		// Fetch transactions with filtering
		const transactions = await prisma.transaction.findMany({
			where: {
				userId: session.user.id,
				...dateFilter
			},
			select: {
				id: true,
				date: true,
				description: true,
				amount: true,
				type: true,
				pairId: true,
				profitAmount: true,
				costAmount: true,
				account: {
					include: {
						category: true
					}
				}
			},
			orderBy: {
				date: 'asc'
			}
		})

		// Transform data for PDF generation
		const txData = transactions.map((tx: any) => ({
			id: tx.id,
			date: tx.date.toISOString().split('T')[0],
			description: tx.description || '',
			amount: tx.amount,
			type: tx.type as 'debit' | 'credit',
			accountName: tx.account?.name || '',
			categoryType: tx.account?.category?.type || ''
		}))

		// Group transactions by pairId for journal entries
		const journalEntries: any[] = []
		const processedPairs = new Set<string>()
		
		txData.forEach((tx) => {
			const pairTx = transactions.find(t => 
				t.pairId === transactions.find(orig => orig.id === tx.id)?.pairId && 
				t.id !== tx.id
			)
			
			if (pairTx && !processedPairs.has(transactions.find(orig => orig.id === tx.id)?.pairId || '')) {
				const debitTx = tx.type === 'debit' ? tx : txData.find(t => t.id === pairTx.id)
				const creditTx = tx.type === 'credit' ? tx : txData.find(t => t.id === pairTx.id)
				
				if (debitTx && creditTx) {
					journalEntries.push({
						date: debitTx.date,
						description: debitTx.description,
						debitAccount: debitTx.accountName,
						debitAmount: debitTx.amount,
						creditAccount: creditTx.accountName,
						creditAmount: creditTx.amount
					})
					processedPairs.add(transactions.find(orig => orig.id === tx.id)?.pairId || '')
				}
			}
		})

		// Calculate financial statement data
		const financialData = calculateFinancialStatements(txData)

		// Fetch Accounts Receivable data
		const arAccount = await prisma.account.findFirst({
			where: { 
				OR: [
					{ code: '1200' },
					{ name: { contains: 'Accounts Receivable' } }
				]
			}
		})

		const receivables: any[] = []
		if (arAccount) {
			const arTransactions = await prisma.transaction.findMany({
				where: {
					userId: session.user.id,
					accountId: arAccount.id,
					...dateFilter
				},
				orderBy: { date: 'desc' }
			})

			// Group by pairId to show receivable entries
			const receivableGroups = new Map<string, any>()

			for (const tx of arTransactions) {
				if (!tx.pairId) continue
				
				if (!receivableGroups.has(tx.pairId)) {
					receivableGroups.set(tx.pairId, {
						pairId: tx.pairId,
						date: tx.date,
						description: tx.description,
						customerName: extractCustomerName(tx.description),
						totalAmount: 0,
						paidAmount: 0
					})
				}

				const group = receivableGroups.get(tx.pairId)!
				if (tx.type === 'debit') {
					group.totalAmount += tx.amount
				} else {
					group.paidAmount += tx.amount
				}
			}

			// Filter unpaid receivables
			receivableGroups.forEach(group => {
				const balance = group.totalAmount - group.paidAmount
				if (balance > 0) {
					const daysOutstanding = Math.floor((Date.now() - group.date.getTime()) / (1000 * 60 * 60 * 24))
					receivables.push({
						date: group.date.toLocaleDateString(),
						customerName: group.customerName,
						description: group.description.replace(/^Unpaid service - [^:]+: /, ''),
						amount: balance,
						daysOutstanding,
						agingCategory: daysOutstanding <= 30 ? 'Current' : 
						               daysOutstanding <= 60 ? '31-60 days' :
						               daysOutstanding <= 90 ? '61-90 days' : 'Over 90 days'
					})
				}
			})
		}

		// Fetch Sales Profit Data
		const salesAccount = await prisma.account.findFirst({
			where: { name: 'Sales Revenue' }
		})

		const salesWithProfit: any[] = []
		if (salesAccount) {
			const salesTransactions = await prisma.transaction.findMany({
				where: {
					userId: session.user.id,
					accountId: salesAccount.id,
					type: 'credit',
					...dateFilter
				},
				select: {
					id: true,
					date: true,
					description: true,
					amount: true,
					type: true,
					profitAmount: true,
					costAmount: true
				},
				orderBy: { date: 'desc' }
			})

			// Get all inventory items
			const inventoryItems = await prisma.inventoryItem.findMany({
				where: { userId: session.user.id }
			})

			const itemMap = new Map(inventoryItems.map(item => [item.name.toLowerCase(), item]))

			// Process sales and calculate profits
			salesTransactions.forEach(tx => {
				// Try to use stored profit/cost data first
				if (tx.profitAmount !== null && tx.costAmount !== null) {
					const match = tx.description.match(/Sale:\s*(.+?)\s*\(([0-9.]+)\s*(.+?)\)/)
					if (match) {
						const itemName = match[1].trim()
						const quantity = parseFloat(match[2])
						const unit = match[3].trim()
						const revenue = tx.amount
						const cost = Number(tx.costAmount)
						const profit = Number(tx.profitAmount)
						const unitCost = cost / quantity
						const unitPrice = revenue / quantity
						const profitMargin = revenue > 0 ? (profit / revenue * 100) : 0

						salesWithProfit.push({
							date: tx.date.toLocaleDateString(),
							itemName,
							quantity,
							unit,
							unitCost,
							unitPrice,
							revenue,
							cost,
							profit,
							profitMargin: profitMargin.toFixed(1)
						})
					}
					return
				}

				// Fall back to parsing and calculating from inventory
				const match = tx.description.match(/Sale:\s*(.+?)\s*\(([0-9.]+)\s*(.+?)\)/)
				if (!match) return

				const itemName = match[1].trim()
				const quantity = parseFloat(match[2])
				const unit = match[3].trim()

				const inventoryItem = itemMap.get(itemName.toLowerCase())
				const revenue = tx.amount
			
				// If item not in inventory or no cost data, still show the sale
				if (!inventoryItem || !(inventoryItem as any).unitCost) {
					const unitPrice = revenue / quantity
					salesWithProfit.push({
						date: tx.date.toLocaleDateString(),
						itemName,
						quantity,
						unit,
						unitCost: 0,
						unitPrice,
						revenue,
						cost: 0,
						profit: 0,
						profitMargin: 'N/A' // No cost data available
					})
					return
				}

				const unitPrice = (inventoryItem as any).unitPrice || (revenue / quantity)
				const unitCost = (inventoryItem as any).unitCost
				const cost = unitCost * quantity
				const profit = revenue - cost
				const profitMargin = revenue > 0 ? (profit / revenue * 100) : 0

				salesWithProfit.push({
					date: tx.date.toLocaleDateString(),
					itemName,
					quantity,
					unit,
					unitCost,
					unitPrice,
					revenue,
					cost,
					profit,
					profitMargin: profitMargin.toFixed(1)
				})
			})
		}

		// Fetch Accounts Payable data
		const apAccount = await prisma.account.findFirst({
			where: { name: 'Accounts Payable' }
		})

		const payables: any[] = []
		if (apAccount) {
			const creditTransactions = await prisma.transaction.findMany({
				where: {
					userId: session.user.id,
					accountId: apAccount.id,
					type: 'credit',
					...dateFilter
				},
				orderBy: { date: 'desc' }
			})

			const debitTransactions = await prisma.transaction.findMany({
				where: {
					userId: session.user.id,
					accountId: apAccount.id,
					type: 'debit'
				}
			})

			// Group by vendor
			const payablesByVendor = new Map<string, { credits: any[], debits: any[] }>()

			creditTransactions.forEach(tx => {
				const vendorName = extractVendorName(tx.description)
				if (!payablesByVendor.has(vendorName)) {
					payablesByVendor.set(vendorName, { credits: [], debits: [] })
				}
				payablesByVendor.get(vendorName)!.credits.push(tx)
			})

			debitTransactions.forEach(tx => {
				const vendorName = extractVendorName(tx.description)
				if (!payablesByVendor.has(vendorName)) {
					payablesByVendor.set(vendorName, { credits: [], debits: [] })
				}
				payablesByVendor.get(vendorName)!.debits.push(tx)
			})

			// Calculate balances
			payablesByVendor.forEach((txs, vendorName) => {
				const totalAmount = txs.credits.reduce((sum, tx) => sum + tx.amount, 0)
				const paidAmount = txs.debits.reduce((sum, tx) => sum + tx.amount, 0)
				const balance = totalAmount - paidAmount

				if (balance > 0) {
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

					payables.push({
						date: oldestCredit.date.toLocaleDateString(),
						vendorName,
						description: oldestCredit.description,
						balance,
						daysOutstanding,
						agingCategory
					})
				}
			})
		}

		// Calculate Cash Flow data
		let cashInflow = 0
		let cashOutflow = 0
		const inflowSources: Record<string, number> = {}
		const outflowPurposes: Record<string, number> = {}

		for (const tx of txData) {
			const accountName = (tx.accountName || '').trim().toLowerCase()
			if (!(accountName === 'cash' || accountName.includes('cash'))) continue
			
			if (tx.type === 'debit') {
				cashInflow += tx.amount
				const source = tx.description || 'Other'
				inflowSources[source] = (inflowSources[source] || 0) + tx.amount
			}
			if (tx.type === 'credit') {
				cashOutflow += tx.amount
				const purpose = tx.description || 'Other'
				outflowPurposes[purpose] = (outflowPurposes[purpose] || 0) + tx.amount
			}
		}

		const cashFlow = {
			totalInflows: cashInflow,
			totalOutflows: cashOutflow,
			netChange: cashInflow - cashOutflow,
			inflowsBySource: Object.entries(inflowSources).sort((a, b) => b[1] - a[1]),
			outflowsByPurpose: Object.entries(outflowPurposes).sort((a, b) => b[1] - a[1])
		}

		// Generate PDF
		const pdfBuffer = await generateFinancialReportPDF({
			journalEntries,
			...financialData,
			receivables,
			salesWithProfit,
			payables,
			cashFlow,
			startDate: startDate || 'All Time',
			endDate: endDate || 'Present',
			generatedDate: new Date().toLocaleDateString()
		})

		// Return PDF
		return new NextResponse(pdfBuffer as any, {
			status: 200,
			headers: {
				'Content-Type': 'application/pdf',
				'Content-Disposition': `attachment; filename="Financial_Report.pdf"`
			}
		})
	} catch (error: any) {
		console.error('Error generating financial report:', error)
		return new NextResponse(error.message || 'Failed to generate report', { status: 500 })
	}
}

// Helper function to extract customer name from description
function extractCustomerName(description: string): string {
	const match = description.match(/Unpaid service - ([^:]+):/)
	if (match) return match[1].trim()
	
	const match2 = description.match(/Outstanding balance for (.+)/i)
	if (match2) return match2[1].trim()
	
	return 'Customer'
}

// Helper function to extract vendor name from description
function extractVendorName(description: string): string {
	// Try to extract from "Payment to [Vendor]" or "Bill from [Vendor]"
	const match1 = description.match(/(?:Payment to|Bill from|Payable to)\s+([^:]+)/i)
	if (match1) return match1[1].trim()
	
	// Try to extract from "Owed to [Vendor]:"
	const match2 = description.match(/Owed to\s+([^:]+):/i)
	if (match2) return match2[1].trim()
	
	return 'Vendor'
}

type TxRow = {
	id: string
	date: string
	description: string
	amount: number
	type: 'debit' | 'credit'
	accountName: string
	categoryType: string
}

function calculateFinancialStatements(rows: TxRow[]) {
	let assetsTotal = 0
	let liabilitiesTotal = 0
	let equityTotal = 0
	let incomeTotal = 0
	let expenseTotal = 0

	const assetAccounts: Record<string, number> = {}
	const liabilityAccounts: Record<string, number> = {}
	const equityAccounts: Record<string, number> = {}
	const incomeAccounts: Record<string, number> = {}
	const expenseAccounts: Record<string, number> = {}

	for (const r of rows) {
		const amount = r.type === 'debit' ? r.amount : -r.amount

		switch (r.categoryType) {
			case 'asset':
				assetsTotal += amount
				assetAccounts[r.accountName] = (assetAccounts[r.accountName] || 0) + amount
				break
			case 'liability':
				liabilitiesTotal -= amount // Credit increases liability
				liabilityAccounts[r.accountName] = (liabilityAccounts[r.accountName] || 0) - amount
				break
			case 'equity':
				equityTotal -= amount // Credit increases equity
				equityAccounts[r.accountName] = (equityAccounts[r.accountName] || 0) - amount
				break
			case 'income':
				if (r.type === 'credit') {
					incomeTotal += r.amount
					incomeAccounts[r.accountName] = (incomeAccounts[r.accountName] || 0) + r.amount
				} else {
					incomeTotal -= r.amount
					incomeAccounts[r.accountName] = (incomeAccounts[r.accountName] || 0) - r.amount
				}
				break
			case 'expense':
				if (r.type === 'debit') {
					expenseTotal += r.amount
					expenseAccounts[r.accountName] = (expenseAccounts[r.accountName] || 0) + r.amount
				} else {
					expenseTotal -= r.amount
					expenseAccounts[r.accountName] = (expenseAccounts[r.accountName] || 0) - r.amount
				}
				break
		}
	}

	const netProfit = incomeTotal - expenseTotal
	const retainedEarnings = netProfit

	return {
		balanceSheet: {
			assets: {
				total: assetsTotal,
				accounts: assetAccounts
			},
			liabilities: {
				total: liabilitiesTotal,
				accounts: liabilityAccounts
			},
			equity: {
				total: equityTotal,
				retainedEarnings,
				accounts: equityAccounts
			}
		},
		incomeStatement: {
			income: {
				total: incomeTotal,
				accounts: incomeAccounts
			},
			expenses: {
				total: expenseTotal,
				accounts: expenseAccounts
			},
			netProfit
		}
	}
}

import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

type JournalEntry = {
	date: string
	description: string
	debitAccount: string
	debitAmount: number
	creditAccount: string
	creditAmount: number
}

type Receivable = {
	date: string
	customerName: string
	description: string
	amount: number
	daysOutstanding: number
	agingCategory: string
}

type SaleWithProfit = {
	date: string
	itemName: string
	quantity: number
	unit: string
	unitCost: number
	unitPrice: number
	revenue: number
	cost: number
	profit: number
	profitMargin: string
}

type Payable = {
	date: string
	vendorName: string
	description: string
	balance: number
	daysOutstanding: number
	agingCategory: string
}

type CashFlowData = {
	totalInflows: number
	totalOutflows: number
	netChange: number
	inflowsBySource: [string, number][]
	outflowsByPurpose: [string, number][]
}

type FinancialReportData = {
	journalEntries: JournalEntry[]
	receivables?: Receivable[]
	salesWithProfit?: SaleWithProfit[]
	payables?: Payable[]
	cashFlow?: CashFlowData
	balanceSheet: {
		assets: {
			total: number
			accounts: Record<string, number>
		}
		liabilities: {
			total: number
			accounts: Record<string, number>
		}
		equity: {
			total: number
			retainedEarnings: number
			accounts: Record<string, number>
		}
	}
	incomeStatement: {
		income: {
			total: number
			accounts: Record<string, number>
		}
		expenses: {
			total: number
			accounts: Record<string, number>
		}
		netProfit: number
	}
	startDate: string
	endDate: string
	generatedDate: string
}

export async function generateFinancialReportPDF(data: FinancialReportData): Promise<Buffer> {
	const doc = new jsPDF()
	
	const pageWidth = doc.internal.pageSize.getWidth()
	let yPosition = 20

	// Header
	doc.setFontSize(20)
	doc.setFont('helvetica', 'bold')
	doc.text('Financial Report', pageWidth / 2, yPosition, { align: 'center' })
	
	yPosition += 10
	doc.setFontSize(11)
	doc.setFont('helvetica', 'normal')
	doc.text(`Period: ${data.startDate} to ${data.endDate}`, pageWidth / 2, yPosition, { align: 'center' })
	
	yPosition += 6
	doc.setFontSize(9)
	doc.setTextColor(100)
	doc.text(`Generated: ${data.generatedDate}`, pageWidth / 2, yPosition, { align: 'center' })
	
	yPosition += 15
	doc.setTextColor(0)

	// Journal Section (First)
	if (data.journalEntries && data.journalEntries.length > 0) {
		doc.setFontSize(16)
		doc.setFont('helvetica', 'bold')
		doc.text('General Journal', 14, yPosition)
		yPosition += 8

		const journalRows = data.journalEntries.map(entry => [
			entry.date,
			entry.description,
			entry.debitAccount,
			formatCurrency(entry.debitAmount),
			entry.creditAccount,
			formatCurrency(entry.creditAmount)
		])

		autoTable(doc, {
			startY: yPosition,
			head: [['Date', 'Description', 'Debit Account', 'Debit', 'Credit Account', 'Credit']],
			body: journalRows,
			theme: 'striped',
			headStyles: { fillColor: [99, 102, 241], fontSize: 9 },
			margin: { left: 14, right: 14 },
			styles: { fontSize: 8 },
			columnStyles: {
				0: { cellWidth: 22 },
				1: { cellWidth: 40 },
				2: { cellWidth: 30 },
				3: { halign: 'right', cellWidth: 25 },
				4: { cellWidth: 30 },
				5: { halign: 'right', cellWidth: 25 }
			}
		})

		yPosition = (doc as any).lastAutoTable.finalY + 15

		// Add new page for Profit Margins
		doc.addPage()
		yPosition = 20
	}

	// Sales Profit Margins Section (Second - moved up)
	if (data.salesWithProfit && data.salesWithProfit.length > 0) {
		doc.setFontSize(16)
		doc.setFont('helvetica', 'bold')
		doc.text('Sales Profit Margins & Total', 14, yPosition)
		yPosition += 8

		const totalRevenue = data.salesWithProfit.reduce((sum, s) => sum + s.revenue, 0)
		const totalCost = data.salesWithProfit.reduce((sum, s) => sum + s.cost, 0)
		const totalProfit = data.salesWithProfit.reduce((sum, s) => sum + s.profit, 0)
	const salesWithMargin = data.salesWithProfit.filter(s => s.profitMargin !== 'N/A')
	const avgMargin = salesWithMargin.length > 0
		? (salesWithMargin.reduce((sum, s) => sum + parseFloat(s.profitMargin), 0) / salesWithMargin.length).toFixed(1)
		: 'N/A'
	const itemsWithoutCost = data.salesWithProfit.filter(s => s.profitMargin === 'N/A').length

	// Summary box
	doc.setFontSize(10)
	doc.setFont('helvetica', 'normal')
	doc.setFillColor(239, 246, 255)
	const boxHeight = itemsWithoutCost > 0 ? 25 : 20
	doc.rect(14, yPosition, pageWidth - 28, boxHeight, 'F')
	doc.text(`Total Revenue: ${formatCurrency(totalRevenue)}`, 18, yPosition + 5)
	doc.text(`Total Cost: ${formatCurrency(totalCost)}`, 18, yPosition + 10)
	doc.text(`Total Profit: ${formatCurrency(totalProfit)}`, 18, yPosition + 15)
	doc.text(`Avg Profit Margin: ${avgMargin}${avgMargin !== 'N/A' ? '%' : ''}`, pageWidth - 80, yPosition + 10)
	if (itemsWithoutCost > 0) {
		doc.setFontSize(8)
		doc.setTextColor(107, 114, 128)
		doc.text(`Note: ${itemsWithoutCost} item(s) missing cost data (marked N/A)`, 18, yPosition + 21)
		doc.setTextColor(0)
		doc.setFontSize(10)
	}
	yPosition += boxHeight + 5

	const salesRows = data.salesWithProfit.map(s => [
		s.date,
		s.itemName,
		`${s.quantity} ${s.unit}`,
		formatCurrency(s.unitCost),
		formatCurrency(s.cost),
		formatCurrency(s.unitPrice),
		formatCurrency(s.revenue),
		formatCurrency(s.profit),
		s.profitMargin === 'N/A' ? 'N/A' : s.profitMargin + '%'
	])

	autoTable(doc, {
		startY: yPosition,
		head: [
			[
				{ content: 'Date', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
				{ content: 'Product', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
				{ content: 'Qty', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
				{ content: 'Company Stock Purchase', colSpan: 2, styles: { halign: 'center', fillColor: [59, 130, 246] } },
				{ content: 'Client Purchase', colSpan: 2, styles: { halign: 'center', fillColor: [34, 197, 94] } },
				{ content: 'Profit', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
				{ content: 'Margin %', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } }
			],
			[
				{ content: 'Unit Cost', styles: { fillColor: [147, 197, 253] } },
				{ content: 'Total Cost', styles: { fillColor: [147, 197, 253] } },
				{ content: 'Unit Price', styles: { fillColor: [134, 239, 172] } },
				{ content: 'Revenue', styles: { fillColor: [134, 239, 172] } }
			]
		],
		body: salesRows,
		theme: 'striped',
		headStyles: { fillColor: [16, 185, 129], fontSize: 8 },
		margin: { left: 14, right: 14 },
		styles: { fontSize: 7 },
		columnStyles: {
			0: { cellWidth: 20 },
			1: { cellWidth: 25 },
			2: { cellWidth: 18 },
			3: { halign: 'right', cellWidth: 20 },
			4: { halign: 'right', cellWidth: 20 },
			5: { halign: 'right', cellWidth: 22 },
			6: { halign: 'right', cellWidth: 20 },
			7: { halign: 'right', cellWidth: 20 },
			8: { halign: 'right', cellWidth: 17 }
		},
		didParseCell: (cellData) => {
			if (cellData.section === 'body' && cellData.column.index === 8) {
				const cellValue = cellData.cell.raw as string
				// Handle N/A values (items without cost data)
				if (cellValue === 'N/A') {
					cellData.cell.styles.fillColor = [229, 231, 235] // Gray
					cellData.cell.styles.textColor = [107, 114, 128] // Gray text
					cellData.cell.styles.fontStyle = 'italic'
					return
				}
				
				const margin = parseFloat(cellValue)
				if (margin >= 30) {
					cellData.cell.styles.fillColor = [220, 252, 231] // Light green
					cellData.cell.styles.textColor = [22, 163, 74] // Green text
				} else if (margin >= 15) {
					cellData.cell.styles.fillColor = [254, 249, 195] // Light yellow
				} else if (margin >= 0) {
					cellData.cell.styles.fillColor = [254, 215, 170] // Light orange
				} else {
					cellData.cell.styles.fillColor = [254, 226, 226] // Light red
					cellData.cell.styles.textColor = [220, 38, 38] // Red text
				}
			}
		}
	})

	// Add new page for Cash Flow
	doc.addPage()
	yPosition = 20
}

// Cash Flow Section (Third)
if (data.cashFlow) {
	doc.setFontSize(16)
	doc.setFont('helvetica', 'bold')
	doc.text('Cash Flow Statement', 14, yPosition)
		yPosition += 8

		// Cash Inflows
		doc.setFontSize(12)
		doc.setFont('helvetica', 'bold')
		doc.text('Cash Inflows', 14, yPosition)
		yPosition += 5

		const inflowRows = data.cashFlow.inflowsBySource.map(([source, amount]) => [
			source,
			formatCurrency(amount)
		])
		inflowRows.push(['Total Cash Inflows', formatCurrency(data.cashFlow.totalInflows)])

		autoTable(doc, {
			startY: yPosition,
			head: [['Source', 'Amount']],
			body: inflowRows,
			theme: 'striped',
			headStyles: { fillColor: [34, 197, 94] },
			margin: { left: 14, right: 14 },
			columnStyles: {
				1: { halign: 'right' }
			},
			didParseCell: (data) => {
				if (data.row.index === inflowRows.length - 1 && data.section === 'body') {
					data.cell.styles.fontStyle = 'bold'
					data.cell.styles.fillColor = [220, 252, 231]
				}
			}
		})

		yPosition = (doc as any).lastAutoTable.finalY + 10

		// Cash Outflows
		doc.setFontSize(12)
		doc.setFont('helvetica', 'bold')
		doc.text('Cash Outflows', 14, yPosition)
		yPosition += 5

		const outflowRows = data.cashFlow.outflowsByPurpose.map(([purpose, amount]) => [
			purpose,
			formatCurrency(amount)
		])
		outflowRows.push(['Total Cash Outflows', formatCurrency(data.cashFlow.totalOutflows)])

		autoTable(doc, {
			startY: yPosition,
			head: [['Purpose', 'Amount']],
			body: outflowRows,
			theme: 'striped',
			headStyles: { fillColor: [239, 68, 68] },
			margin: { left: 14, right: 14 },
			columnStyles: {
				1: { halign: 'right' }
			},
			didParseCell: (data) => {
				if (data.row.index === outflowRows.length - 1 && data.section === 'body') {
					data.cell.styles.fontStyle = 'bold'
					data.cell.styles.fillColor = [254, 226, 226]
				}
			}
		})

		yPosition = (doc as any).lastAutoTable.finalY + 10

		// Net Cash Change
		const isPositive = data.cashFlow.netChange >= 0

		autoTable(doc, {
			startY: yPosition,
			body: [
				['Net Cash Change', formatCurrency(Math.abs(data.cashFlow.netChange))]
			],
			theme: 'grid',
			margin: { left: 14, right: 14 },
			columnStyles: {
				0: { fontStyle: 'bold', fontSize: 12 },
				1: { halign: 'right', fontStyle: 'bold', fontSize: 12 }
			},
			styles: {
				fillColor: isPositive ? [220, 252, 231] : [254, 226, 226],
				textColor: isPositive ? [22, 163, 74] : [220, 38, 38]
			}
		})

		// Add new page for Unpaid Services
		doc.addPage()
		yPosition = 20
	}

	// Accounts Receivable Section (Fourth - Unpaid Services)
	if (data.receivables && data.receivables.length > 0) {
		doc.setFontSize(16)
		doc.setFont('helvetica', 'bold')
		doc.text('Unpaid Services (Accounts Receivable)', 14, yPosition)
		yPosition += 8

		const totalUnpaid = data.receivables.reduce((sum, r) => sum + r.amount, 0)

		// Summary box
		doc.setFontSize(10)
		doc.setFont('helvetica', 'normal')
		doc.setFillColor(239, 246, 255)
		doc.rect(14, yPosition, pageWidth - 28, 15, 'F')
		doc.text(`Total Outstanding: ${formatCurrency(totalUnpaid)}`, 18, yPosition + 6)
		doc.text(`Number of Unpaid Services: ${data.receivables.length}`, 18, yPosition + 11)
		yPosition += 20

		const receivableRows = data.receivables.map(r => [
			r.date,
			r.customerName,
			r.description.substring(0, 40),
			formatCurrency(r.amount),
			r.daysOutstanding.toString() + ' days',
			r.agingCategory
		])

		autoTable(doc, {
			startY: yPosition,
			head: [['Date', 'Customer', 'Description', 'Amount', 'Days Out', 'Aging']],
			body: receivableRows,
			theme: 'striped',
			headStyles: { fillColor: [234, 88, 12], fontSize: 9 },
			margin: { left: 14, right: 14 },
			styles: { fontSize: 8 },
			columnStyles: {
				0: { cellWidth: 22 },
				1: { cellWidth: 30 },
				2: { cellWidth: 50 },
				3: { halign: 'right', cellWidth: 25 },
				4: { cellWidth: 22 },
				5: { cellWidth: 23 }
			},
			didParseCell: (cellData) => {
				if (cellData.section === 'body' && cellData.column.index === 5) {
					const aging = cellData.cell.raw as string
					if (aging === 'Current') {
						cellData.cell.styles.fillColor = [220, 252, 231]
					} else if (aging === '31-60 days') {
						cellData.cell.styles.fillColor = [254, 249, 195]
					} else if (aging === '61-90 days') {
						cellData.cell.styles.fillColor = [254, 215, 170]
					} else {
						cellData.cell.styles.fillColor = [254, 226, 226]
					}
				}
			}
		})

		// Add new page for Accounts Payable
		doc.addPage()
		yPosition = 20
	}

	// Accounts Payable Section (Fifth)
	if (data.payables && data.payables.length > 0) {
		doc.setFontSize(16)
		doc.setFont('helvetica', 'bold')
		doc.text('Accounts Payable', 14, yPosition)
		yPosition += 8

		const totalOwed = data.payables.reduce((sum, p) => sum + p.balance, 0)

		// Summary box
		doc.setFontSize(10)
		doc.setFont('helvetica', 'normal')
		doc.setFillColor(254, 242, 242)
		doc.rect(14, yPosition, pageWidth - 28, 15, 'F')
		doc.text(`Total Amount Owed: ${formatCurrency(totalOwed)}`, 18, yPosition + 6)
		doc.text(`Number of Vendors: ${data.payables.length}`, 18, yPosition + 11)
		yPosition += 20

		const payableRows = data.payables.map(p => [
			p.date,
			p.vendorName,
			p.description.substring(0, 40),
			formatCurrency(p.balance),
			p.daysOutstanding.toString() + ' days',
			p.agingCategory
		])

		autoTable(doc, {
			startY: yPosition,
			head: [['Date', 'Vendor', 'Description', 'Balance', 'Days Out', 'Aging']],
			body: payableRows,
			theme: 'striped',
			headStyles: { fillColor: [220, 38, 38], fontSize: 9 },
			margin: { left: 14, right: 14 },
			styles: { fontSize: 8 },
			columnStyles: {
				0: { cellWidth: 22 },
				1: { cellWidth: 30 },
				2: { cellWidth: 50 },
				3: { halign: 'right', cellWidth: 25 },
				4: { cellWidth: 22 },
				5: { cellWidth: 23 }
			},
			didParseCell: (cellData) => {
				if (cellData.section === 'body' && cellData.column.index === 5) {
					const aging = cellData.cell.raw as string
					if (aging === 'Current' || aging === '1-30 days') {
						cellData.cell.styles.fillColor = [220, 252, 231]
					} else if (aging === '31-60 days') {
						cellData.cell.styles.fillColor = [254, 249, 195]
					} else {
						cellData.cell.styles.fillColor = [254, 226, 226]
					}
				}
			}
		})

		// Add new page for Income Statement
		doc.addPage()
		yPosition = 20
	}

	// Income Statement Section (Sixth)
	doc.setFontSize(16)
	doc.setFont('helvetica', 'bold')
	doc.text('Income Statement', 14, yPosition)
	yPosition += 8

	// Revenue/Income
	doc.setFontSize(12)
	doc.setFont('helvetica', 'bold')
	doc.text('Revenue', 14, yPosition)
	yPosition += 5

	const incomeRows = Object.entries(data.incomeStatement.income.accounts).map(([name, amount]) => [
		name,
		formatCurrency(amount)
	])
	incomeRows.push(['Total Revenue', formatCurrency(data.incomeStatement.income.total)])

	autoTable(doc, {
		startY: yPosition,
		head: [['Account', 'Amount']],
		body: incomeRows,
		theme: 'striped',
		headStyles: { fillColor: [34, 197, 94] },
		margin: { left: 14, right: 14 },
		columnStyles: {
			1: { halign: 'right' }
		},
		didParseCell: (data) => {
			if (data.row.index === incomeRows.length - 1 && data.section === 'body') {
				data.cell.styles.fontStyle = 'bold'
				data.cell.styles.fillColor = [220, 252, 231]
			}
		}
	})

	yPosition = (doc as any).lastAutoTable.finalY + 10

	// Expenses
	doc.setFontSize(12)
	doc.setFont('helvetica', 'bold')
	doc.text('Expenses', 14, yPosition)
	yPosition += 5

	const expenseRows = Object.entries(data.incomeStatement.expenses.accounts).map(([name, amount]) => [
		name,
		formatCurrency(amount)
	])
	expenseRows.push(['Total Expenses', formatCurrency(data.incomeStatement.expenses.total)])

	autoTable(doc, {
		startY: yPosition,
		head: [['Account', 'Amount']],
		body: expenseRows,
		theme: 'striped',
		headStyles: { fillColor: [239, 68, 68] },
		margin: { left: 14, right: 14 },
		columnStyles: {
			1: { halign: 'right' }
		},
		didParseCell: (data) => {
			if (data.row.index === expenseRows.length - 1 && data.section === 'body') {
				data.cell.styles.fontStyle = 'bold'
				data.cell.styles.fillColor = [254, 226, 226]
			}
		}
	})

	yPosition = (doc as any).lastAutoTable.finalY + 10

	// Net Profit/Loss
	const isProfit = data.incomeStatement.netProfit >= 0

	autoTable(doc, {
		startY: yPosition,
		body: [
			['Total Revenue', formatCurrency(data.incomeStatement.income.total)],
			['Total Expenses', formatCurrency(data.incomeStatement.expenses.total)],
			[isProfit ? 'Net Profit' : 'Net Loss', formatCurrency(Math.abs(data.incomeStatement.netProfit))]
		],
		theme: 'grid',
		margin: { left: 14, right: 14 },
		columnStyles: {
			0: { fontStyle: 'bold' },
			1: { halign: 'right' }
		},
		didParseCell: (data) => {
			if (data.row.index === 2) {
				data.cell.styles.fillColor = isProfit ? [220, 252, 231] : [254, 226, 226]
				data.cell.styles.fontStyle = 'bold'
				data.cell.styles.fontSize = 12
			}
		}
	})

	// Add new page for Balance Sheet (Seventh - Final)
	doc.addPage()
	yPosition = 20

	// Balance Sheet Section
	doc.setFontSize(16)
	doc.setFont('helvetica', 'bold')
	doc.text('Balance Sheet', 14, yPosition)
	yPosition += 8

	// Assets
	doc.setFontSize(12)
	doc.setFont('helvetica', 'bold')
	doc.text('Assets', 14, yPosition)
	yPosition += 5

	const assetRows = Object.entries(data.balanceSheet.assets.accounts).map(([name, amount]) => [
		name,
		formatCurrency(amount)
	])
	assetRows.push(['Total Assets', formatCurrency(data.balanceSheet.assets.total)])

	autoTable(doc, {
		startY: yPosition,
		head: [['Account', 'Amount']],
		body: assetRows,
		theme: 'striped',
		headStyles: { fillColor: [59, 130, 246] },
		margin: { left: 14, right: 14 },
		columnStyles: {
			1: { halign: 'right' }
		},
		didParseCell: (data) => {
			if (data.row.index === assetRows.length - 1 && data.section === 'body') {
				data.cell.styles.fontStyle = 'bold'
				data.cell.styles.fillColor = [219, 234, 254]
			}
		}
	})

	yPosition = (doc as any).lastAutoTable.finalY + 10

	// Liabilities
	doc.setFontSize(12)
	doc.setFont('helvetica', 'bold')
	doc.text('Liabilities', 14, yPosition)
	yPosition += 5

	const liabilityRows = Object.entries(data.balanceSheet.liabilities.accounts).map(([name, amount]) => [
		name,
		formatCurrency(amount)
	])
	liabilityRows.push(['Total Liabilities', formatCurrency(data.balanceSheet.liabilities.total)])

	autoTable(doc, {
		startY: yPosition,
		head: [['Account', 'Amount']],
		body: liabilityRows,
		theme: 'striped',
		headStyles: { fillColor: [59, 130, 246] },
		margin: { left: 14, right: 14 },
		columnStyles: {
			1: { halign: 'right' }
		},
		didParseCell: (data) => {
			if (data.row.index === liabilityRows.length - 1 && data.section === 'body') {
				data.cell.styles.fontStyle = 'bold'
				data.cell.styles.fillColor = [219, 234, 254]
			}
		}
	})

	yPosition = (doc as any).lastAutoTable.finalY + 10

	// Equity
	doc.setFontSize(12)
	doc.setFont('helvetica', 'bold')
	doc.text('Equity', 14, yPosition)
	yPosition += 5

	const equityRows = Object.entries(data.balanceSheet.equity.accounts).map(([name, amount]) => [
		name,
		formatCurrency(amount)
	])
	equityRows.push(['Retained Earnings', formatCurrency(data.balanceSheet.equity.retainedEarnings)])
	equityRows.push(['Total Equity', formatCurrency(data.balanceSheet.equity.total + data.balanceSheet.equity.retainedEarnings)])

	autoTable(doc, {
		startY: yPosition,
		head: [['Account', 'Amount']],
		body: equityRows,
		theme: 'striped',
		headStyles: { fillColor: [59, 130, 246] },
		margin: { left: 14, right: 14 },
		columnStyles: {
			1: { halign: 'right' }
		},
		didParseCell: (data) => {
			if (data.row.index === equityRows.length - 1 && data.section === 'body') {
				data.cell.styles.fontStyle = 'bold'
				data.cell.styles.fillColor = [219, 234, 254]
			}
		}
	})

	yPosition = (doc as any).lastAutoTable.finalY + 10

	// Balance Sheet Summary
	const totalLiabilitiesAndEquity = data.balanceSheet.liabilities.total + data.balanceSheet.equity.total + data.balanceSheet.equity.retainedEarnings
	const balanced = Math.abs(data.balanceSheet.assets.total - totalLiabilitiesAndEquity) < 0.01

	autoTable(doc, {
		startY: yPosition,
		body: [
			['Total Assets', formatCurrency(data.balanceSheet.assets.total)],
			['Total Liabilities + Equity', formatCurrency(totalLiabilitiesAndEquity)],
			['Difference', formatCurrency(data.balanceSheet.assets.total - totalLiabilitiesAndEquity)],
			['Status', balanced ? '✓ Balanced' : '✗ Not Balanced']
		],
		theme: 'grid',
		margin: { left: 14, right: 14 },
		columnStyles: {
			0: { fontStyle: 'bold' },
			1: { halign: 'right' }
		},
		styles: {
			fillColor: balanced ? [220, 252, 231] : [254, 226, 226]
		}
	})

	// Footer
	const totalPages = doc.getNumberOfPages()
	for (let i = 1; i <= totalPages; i++) {
		doc.setPage(i)
		doc.setFontSize(8)
		doc.setTextColor(150)
		doc.text(
			`Page ${i} of ${totalPages}`,
			pageWidth / 2,
			doc.internal.pageSize.getHeight() - 10,
			{ align: 'center' }
		)
	}

	// Convert to buffer
	const pdfArrayBuffer = doc.output('arraybuffer')
	return Buffer.from(pdfArrayBuffer)
}

function formatCurrency(amount: number): string {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'RWF',
		minimumFractionDigits: 0,
		maximumFractionDigits: 0
	}).format(amount)
}

// Invoice generation
type InvoiceItem = {
	name: string
	quantity: number
	unit: string
	unitPrice: number
	subtotal: number
}

type InvoiceData = {
	invoiceNumber: string
	date: string
	businessName: string
	logoUrl?: string
	items: InvoiceItem[]
	total: number
	paymentMethod: string
}

export async function generateInvoicePDF(data: InvoiceData): Promise<Blob> {
	const doc = new jsPDF()
	const pageWidth = doc.internal.pageSize.getWidth()
	let yPos = 20

	// Add logo if available
	if (data.logoUrl) {
		try {
			// Add logo (assuming it's already a base64 or URL)
			doc.addImage(data.logoUrl, 'PNG', 15, yPos, 40, 40)
			yPos += 45
		} catch (error) {
			console.error('Failed to add logo to invoice:', error)
		}
	}

	// Business name
	doc.setFontSize(20)
	doc.setFont('helvetica', 'bold')
	doc.text(data.businessName || 'Business Invoice', pageWidth / 2, yPos, { align: 'center' })
	yPos += 10

	// Invoice title
	doc.setFontSize(16)
	doc.text('SALES INVOICE', pageWidth / 2, yPos, { align: 'center' })
	yPos += 15

	// Invoice details
	doc.setFontSize(10)
	doc.setFont('helvetica', 'normal')
	doc.text(`Invoice #: ${data.invoiceNumber}`, 15, yPos)
	doc.text(`Date: ${data.date}`, pageWidth - 15, yPos, { align: 'right' })
	yPos += 10
	doc.text(`Payment Method: ${data.paymentMethod}`, 15, yPos)
	yPos += 15

	// Items table
	const tableData = data.items.map((item) => [
		item.name,
		`${item.quantity} ${item.unit}`,
		formatCurrency(item.unitPrice),
		formatCurrency(item.subtotal)
	])

	autoTable(doc, {
		startY: yPos,
		head: [['Item', 'Quantity', 'Unit Price', 'Subtotal']],
		body: tableData,
		theme: 'striped',
		headStyles: {
			fillColor: [66, 139, 202],
			textColor: 255,
			fontStyle: 'bold'
		},
		styles: {
			fontSize: 10,
			cellPadding: 5
		},
		columnStyles: {
			0: { cellWidth: 80 },
			1: { cellWidth: 30, halign: 'center' },
			2: { cellWidth: 40, halign: 'right' },
			3: { cellWidth: 40, halign: 'right' }
		}
	})

	// Get final Y position after table
	const finalY = (doc as any).lastAutoTable.finalY + 10

	// Total
	doc.setFontSize(12)
	doc.setFont('helvetica', 'bold')
	doc.text('TOTAL:', pageWidth - 80, finalY)
	doc.text(formatCurrency(data.total), pageWidth - 15, finalY, { align: 'right' })

	// Footer
	doc.setFontSize(8)
	doc.setFont('helvetica', 'italic')
	doc.text(
		'Thank you for your business!',
		pageWidth / 2,
		doc.internal.pageSize.getHeight() - 20,
		{ align: 'center' }
	)

	return doc.output('blob')
}

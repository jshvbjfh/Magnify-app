import { GoogleGenerativeAI } from '@google/generative-ai'

/**
 * Fetches the live list of models available for the given API key,
 * then returns a priority-ordered candidate list.
 * Falls back to a hardcoded list if the API call fails.
 */
export async function getGeminiCandidates(apiKey: string): Promise<string[]> {
	const preferred = [
		process.env.GEMINI_MODEL,
		'gemini-1.5-flash',
		'gemini-1.5-pro',
		'gemini-2.0-flash-exp',
		'gemini-2.0-flash',
		'gemini-pro',
		'gemini-1.0-pro'
	].filter(Boolean) as string[]

	try {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
		)
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		const data = await res.json()
		const available: string[] = (data.models || [])
			.filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
			.map((m: any) => (m.name as string).replace('models/', ''))

		const candidates: string[] = []
		// Priority-ordered first
		for (const p of preferred) {
			if (available.includes(p) && !candidates.includes(p)) candidates.push(p)
		}
		// Remaining available models as fallback
		for (const a of available) {
			if (!candidates.includes(a)) candidates.push(a)
		}
		if (candidates.length > 0) return candidates
	} catch { /* fall through to hardcoded list */ }

	// Hardcoded fallback
	return [...new Set(preferred)]
}

export type ExtractedTransaction = {
	date?: string
	description: string
	summary?: string
	amount: number
	direction: 'in' | 'out'
	categoryType?: 'income' | 'expense' | 'asset' | 'liability' | 'equity'
	accountName?: string
}

export type ExtractResult = {
	rawText: string
	translatedText: string
	transactions: ExtractedTransaction[]
	unknownWords: string[]
}

export type AnalyticsChart = {
	title: string
	type: 'bar' | 'line'
	xKey: string
	yKey: string
	data: Array<Record<string, string | number>>
	note?: string
}

export type AnalyticsTable = {
	title: string
	columns: string[]
	rows: Array<Array<string | number>>
}

export type AnalyticsInsights = {
	headline: string
	comments: string[]
	advice: string[]
	charts: AnalyticsChart[]
	tables: AnalyticsTable[]
}

function pickMimeType(fileType: string | undefined) {
	const t = (fileType || '').toLowerCase()
	if (t.startsWith('image/')) return t
	return 'image/png'
}

function extractJson(text: string) {
	const cleaned = text
		.replace(/```json\s*/gi, '')
		.replace(/```\s*/g, '')
		.trim()
	const start = cleaned.indexOf('{')
	const end = cleaned.lastIndexOf('}')
	if (start === -1 || end === -1 || end <= start) {
		throw new Error('AI response did not contain JSON')
	}
	return cleaned.slice(start, end + 1)
}

export async function generateAnalyticsInsights(dataset: any): Promise<AnalyticsInsights> {
	const apiKey = process.env.GEMINI_API_KEY
	if (!apiKey) {
		throw new Error('Missing GEMINI_API_KEY')
	}

	const genAI = new GoogleGenerativeAI(apiKey)
	const candidateModels = await getGeminiCandidates(apiKey)

	const bp = dataset.businessProfile || {}
	const summary = dataset.summary || {}
	const spendingAlerts = dataset.spendingAlerts || []
	const topProducts = bp.topProducts || []
	const revenueChannels = bp.revenueChannels || {}
	const fleetInsights = bp.fleetInsights || {}
	const laborInsights = bp.laborInsights || {}

	// Build a rich business context narrative for the AI
	const businessContext = `
BUSINESS PROFILE:
- Industry: ${bp.detectedIndustry || 'unknown'} 
- Description: ${bp.industryDescription || ''}
- Declared business type: ${bp.declaredBusinessType || 'not set'}

REVENUE CHANNELS:
- Retail sales: ${revenueChannels.retailPercent || 0}% of revenue
- B2B / Wholesale: ${revenueChannels.b2bPercent || 0}% of revenue
- Known B2B clients: ${(revenueChannels.b2bClients || []).join(', ') || 'none detected'}

TOP PRODUCTS BY REVENUE (from parsed sales):
${topProducts.length > 0 ? topProducts.map((p: any) => `  - ${p.name}: ${p.revenue?.toLocaleString()} RWF`).join('\n') : '  No individual product data detected'}

FLEET / VEHICLE OPERATIONS:
- Total vehicle maintenance spend: ${fleetInsights.totalVehicleCost?.toLocaleString() || 0} RWF
- Fleet expense transactions: ${fleetInsights.transactions || 0}
- Has active fleet: ${fleetInsights.hasFleet ? 'YES' : 'NO'}

LABOR COSTS:
- Driver & staff payments: ${laborInsights.totalLaborCost?.toLocaleString() || 0} RWF
- Labor transactions: ${laborInsights.transactions || 0}

FINANCIAL SUMMARY:
- Total Income: ${summary.totalIncome?.toLocaleString() || 0} RWF
- Cost of Goods Sold: ${summary.cogsTotal?.toLocaleString() || 0} RWF
- Gross Profit: ${summary.grossProfit?.toLocaleString() || 0} RWF (${summary.grossMargin || 0}% margin)
- Total Expenses: ${summary.totalExpense?.toLocaleString() || 0} RWF
- Net ${(summary.netProfit || 0) >= 0 ? 'PROFIT' : 'LOSS'}: ${Math.abs(summary.netProfit || 0).toLocaleString()} RWF (${summary.netMargin || 0}% net margin)
- Total transactions: ${summary.totalTransactions || 0}
- Month-over-month net change: ${summary.momNetChange != null ? summary.momNetChange.toLocaleString() + ' RWF (' + (summary.momNetChangePercent || 0) + '%)' : 'N/A'}

SPENDING ALERTS (accounts consuming >30% of total expenses):
${spendingAlerts.length > 0 ? spendingAlerts.map((a: string) => `  ! ${a}`).join('\n') : '  None'}
`

	const prompt = `You are a specialist business analyst and CFO copilot for an African SME.

${businessContext}

FULL ACCOUNTING LEDGER — EVERY TRANSACTION (use these for accurate numbers):
${JSON.stringify(dataset.fullTransactionLedger || [], null, 2)}

CURRENT INVENTORY:
${JSON.stringify(dataset.fullInventory || [], null, 2)}

PRE-CALCULATED AGGREGATES (for cross-checking):
${JSON.stringify({
		monthlyTrend: dataset.monthlyTrend,
		topExpenseAccounts: dataset.topExpenseAccounts,
		topIncomeAccounts: dataset.topIncomeAccounts,
		paymentMethodMix: dataset.paymentMethodMix,
		weekdayRevenue: dataset.weekdayRevenue
	}, null, 2)}

YOUR TASK:
You have the COMPLETE transaction history above. Derive all numbers directly from it.
DO NOT invent or estimate any figure — every number you cite must come from the ledger rows above.

Based on this specific business — ${bp.industryDescription || 'a trading business'} — act as their business analyst.

Step 1 - SCAN the full transaction ledger above. Count, sum, and group by account/description.
Step 2 - IDENTIFY what's unusual, risky, growing, or declining from the REAL numbers.
Step 3 - CREATE the most useful analytics for this business type:
  - For a produce business: product margins, spoilage risk, B2B vs retail split, price volatility
  - For a fleet business: vehicle maintenance as % of revenue, driver cost trends
  - For wholesale: client concentration risk, bulk order patterns

RULES:
- Every number in your output must trace back to a real row in fullTransactionLedger above.
- If net profit is positive, say PROFIT. If negative, say LOSS. Never confuse them.
- Chart data rows must only contain values that actually exist in the ledger.
- Keep chart data arrays <= 12 rows. Table rows <= 12.
- Make advice specific to their real patterns, not generic.
- Tailor everything to detected industry: ${bp.detectedIndustry}

OUTPUT JSON SCHEMA (strict, no markdown, no code fences):
{
  "headline": string (one sharp executive sentence with real numbers),
  "comments": string[] (4-8 specific observations with actual figures from the ledger),
  "advice": string[] (3-6 concrete action steps addressing REAL patterns found in the data),
  "charts": [
    {
      "title": string,
      "type": "bar" | "line",
      "xKey": string,
      "yKey": string,
      "data": [{ [xKey]: string|number, [yKey]: number }],
      "note": string (why this chart matters for their business)
    }
  ],
  "tables": [
    {
      "title": string,
      "columns": string[],
      "rows": (string|number)[][]
    }
  ]
}`

	let lastError: any
	for (const modelName of candidateModels) {
		try {
			const model = genAI.getGenerativeModel({ model: modelName })
			const result = await model.generateContent([{ text: prompt }])
			const text = result.response.text()
			const parsed = JSON.parse(extractJson(text))

			const charts: AnalyticsChart[] = Array.isArray(parsed.charts)
				? parsed.charts
					.filter((c: any) => c && (c.type === 'bar' || c.type === 'line') && c.xKey && c.yKey && Array.isArray(c.data))
					.slice(0, 5)
					.map((c: any) => ({
						title: String(c.title || 'Chart'),
						type: c.type,
						xKey: String(c.xKey),
						yKey: String(c.yKey),
						data: c.data.slice(0, 12).map((row: any) => ({ ...row })),
						note: c.note ? String(c.note) : undefined
					}))
				: []

			const tables: AnalyticsTable[] = Array.isArray(parsed.tables)
				? parsed.tables
					.filter((t: any) => t && Array.isArray(t.columns) && Array.isArray(t.rows))
					.slice(0, 4)
					.map((t: any) => ({
						title: String(t.title || 'Table'),
						columns: t.columns.slice(0, 8).map((c: any) => String(c)),
						rows: t.rows.slice(0, 12).map((r: any) => Array.isArray(r) ? r.slice(0, 8).map((v: any) => typeof v === 'number' ? v : String(v)) : [])
					}))
				: []

			return {
				headline: String(parsed.headline || 'AI analytics generated from your accounting data.'),
				comments: Array.isArray(parsed.comments) ? parsed.comments.slice(0, 8).map(String) : [],
				advice: Array.isArray(parsed.advice) ? parsed.advice.slice(0, 6).map(String) : [],
				charts,
				tables
			}
		} catch (e: any) {
			lastError = e
			continue
		}
	}

	throw lastError || new Error('Analytics AI generation failed')
}

export async function extractFromImage(params: {
	imageBase64: string
	mimeType?: string
	dictionary?: Array<{ kinyarwandaWord: string; englishMeaning: string; context?: string | null }>
}): Promise<ExtractResult> {
	const apiKey = process.env.GEMINI_API_KEY
	if (!apiKey) throw new Error('Missing GEMINI_API_KEY')

	const genAI = new GoogleGenerativeAI(apiKey)
	const candidateModels = await getGeminiCandidates(apiKey)

	const dictLines = (params.dictionary ?? [])
		.map((d) => `- ${d.kinyarwandaWord} => ${d.englishMeaning}${d.context ? ` (context: ${d.context})` : ''}`)
		.join('\n')

	const hasDictionary = dictLines.length > 0

	const prompt = `You are an accounting assistant specialized in extracting financial transactions from business documents.

Task:
1) Read the document (WhatsApp chat, invoice, sales record, or business document).
2) Extract ALL financial transactions that occurred.
3) Translate any non-English text to English.
4) For each transaction, specify the EXACT account name affected.

DOCUMENT TYPES YOU WILL SEE:
A) INVOICES / SALES RECORDS showing items sold to customers:
   - Look for: Client name, date, list of items with quantities and prices
   - Create TWO types of entries:
     1. COST OF GOODS SOLD (what you paid for the inventory):
        - direction: "out"
        - accountName: "Cost of Goods Sold" 
        - categoryType: "expense"
        - amount: total purchase cost
     2. SALES REVENUE (what customer will pay you):
        - direction: "in"
        - accountName: "Accounts Receivable" OR "Sales Revenue"
        - If payment status says "credit", "pending", "will pay later": use "Accounts Receivable"
        - If already paid: use "Cash"
        - categoryType: "income"
        - amount: total sale price
   - ALWAYS extract BOTH the cost and revenue from an invoice/sales document

B) WHATSAPP CHAT MESSAGES (casual Kinyarwanda conversations):
   - "Yofinder" = business owner (us)
   - Payments TO Yofinder = income (direction: "in")
   - Payments FROM Yofinder = expenses (direction: "out")

IMPORTANT BUSINESS CONTEXT:
- "Yofinder" is the business owner (us).
- If someone says "I sent X to Yofinder" or "You sent X to Yofinder", this means WE RECEIVED money (direction: "in", income).
- If Yofinder sends money to someone else, that is money going out (direction: "out", expense).
- Always treat payments TO Yofinder as income/money received.
- Always treat payments FROM Yofinder as expenses/money sent.

ACCOUNTS RECEIVABLE (Services Provided, Payment Pending):
- If service is provided but payment is not yet received (e.g., "delivered goods, will pay later", "service done, payment pending", "invoice sent", "credit", "on credit"), create TWO entries:
  1) Debit: Accounts Receivable (accountName: "Accounts Receivable", direction: "in") - money they owe us
  2) Credit: Service Revenue (accountName: "Service Revenue", direction: "in") - income earned
- If customer later pays what they owed, create TWO entries:
  1) Debit: Cash (accountName: "Cash", direction: "in") - cash received
  2) Credit: Accounts Receivable (accountName: "Accounts Receivable", direction: "out") - they no longer owe us
- Keywords indicating receivables: "will pay later", "on credit", "invoice sent", "payment pending", "owes", "receivable", "credit"

ACCOUNTS PAYABLE / NOTES PAYABLE (Purchases on Credit, Loans Taken):
- CRITICAL: When we buy something "on credit", "take a loan", "will pay later", "not paid yet", this means NO CASH was exchanged yet!
- DO NOT credit Cash on the purchase date - we haven't paid yet!
- Examples: "bought fuel on credit", "took diesel as loan", "purchased supplies, will pay next week", "borrowed money"
- When goods/services/loans are received on credit (Jan 7):
  1) Debit: Expense account (e.g., Fuel Expense) - expense incurred now
  2) Credit: Accounts Payable (accountName: "Accounts Payable") - we owe them money
  3) Set paymentMethod to "Credit" not "Cash"
- When we later pay the debt (Jan 8):
  1) Debit: Accounts Payable - reducing what we owe
  2) Credit: Cash - cash goes out NOW (not on purchase date)
  3) Set paymentMethod to "Cash"
- Keywords: "on credit", "loan", "taken", "borrowed", "will pay later", "not paid yet", "payable", "owes"
- WRONG: DR Expense/CR Cash on purchase date (this means you paid immediately!)
- CORRECT: DR Expense/CR Accounts Payable on purchase date, then DR Accounts Payable/CR Cash on payment date
  2) Credit: Cash (direction: "out") - cash paid

DATE INTERPRETATION (Kinyarwanda expressions):
- "Kubu Nani" / "kubinani" / "on New Year" / "New Year's Day" = January 1st of the current year
- "Noheri" / "Christmas" / "Noel" = December 25th
- "Easter" / "Pasika" = (calculate based on year context)
- If a date phrase references a holiday or event, translate it to the actual date in YYYY-MM-DD format
- Current context year: 2026
- Example: "Kubu Nani" mentioned now = 2026-01-01

${hasDictionary ? `CUSTOM DICTIONARY - YOU MUST USE THESE DEFINITIONS:
The following words have been pre-defined by the user. ALWAYS use these exact meanings when you encounter these words. DO NOT add these words to unknownWords if they appear in the text:
${dictLines}

CRITICAL: If any word from the dictionary appears in the image, use the provided English meaning. Do NOT mark it as unknown.
` : 'Dictionary: (none)'}

Output MUST be valid JSON only with this schema:
{
  "rawText": string,
  "translatedText": string,
  "unknownWords": string[],
  "transactions": [
    {
      "date": "YYYY-MM-DD" (optional),
      "description": string (detailed explanation, mention if it's receivable/payable),
      "summary": string (SHORT 2-4 word label for grouping, e.g., "Fuel Purchase", "Driver Payment", "Customer Payment", "AR - Service Revenue", "Payment on Account"),
      "amount": number,
      "direction": "in" | "out",
      "categoryType": "income" | "expense" | "asset" | "liability" | "equity" (optional),
      "accountName": string (e.g., "Cash", "Accounts Receivable", "Accounts Payable", "Service Revenue", specific account names)
    }
  ]
}

Rules:
- ALWAYS specify accountName for EVERY transaction - never leave it empty!
- For RECEIVABLES: Generate multiple transactions - one for Accounts Receivable (debit/asset increase) and one for Revenue (credit/income)
- For PAYABLES: Generate multiple transactions - one for Expense (debit) and one for Accounts Payable (credit/liability increase)
- For INVENTORY SALES: Generate both Cost of Goods Sold (expense) AND Sales Revenue (income) entries
- When payment is made on a receivable/payable, show Cash and AR/AP accounts
- SUMMARY field must be SHORT (2-4 words max) for grouping similar transactions.
- DESCRIPTION can be detailed, but SUMMARY should be concise category label.
- Example: description="Service provided to client ABC on credit, payment due next week", summary="AR - Service Revenue", accountName="Service Revenue"
- Example: description="Customer paid outstanding balance for services rendered last month", summary="Payment on Account", accountName="Cash"
- Example (invoice): description="Cost of inventory sold to customer", summary="Cost of Goods", accountName="Cost of Goods Sold"
- Example (invoice): description="Revenue from sale to customer on credit", summary="Sales Revenue", accountName="Accounts Receivable"
- ALWAYS provide accountName - use these standard accounts:
  * Cash - for cash receipts and payments
  * Accounts Receivable - for sales on credit (customer owes you)
  * Accounts Payable - for purchases on credit (you owe supplier)
  * Sales Revenue / Service Revenue - for income earned
  * Cost of Goods Sold - for inventory costs
  * [Specific Expense Name] - for various expenses (Fuel Expense, Salary Expense, etc.)
- If unsure of exact account, use the closest match from the list above
- Keep amounts numeric (no currency symbols).
- If a Kinyarwanda/slang word meaning is unclear OR you're uncertain about the context, include it in unknownWords.
- Flag words that might be ambiguous, business-specific jargon, or have multiple possible interpretations.
- Always extract transactions even if some words are unknown.
- Remember: Yofinder = us, so payments TO Yofinder = income (direction: "in").
- direction MUST be either "in" or "out" - never leave it empty!
`

	const inlineData = {
		data: params.imageBase64,
		mimeType: pickMimeType(params.mimeType)
	}

	let lastError: any
	for (const modelName of candidateModels) {
		try {
			const model = genAI.getGenerativeModel({ model: modelName })
			const result = await model.generateContent([
				{ text: prompt },
				{ inlineData }
			])
			const text = result.response.text()
			const jsonText = extractJson(text)
			const parsed = JSON.parse(jsonText)

			// Validate transactions before returning
			const validatedTransactions = Array.isArray(parsed.transactions)
				? parsed.transactions.filter((t: any) => {
					// Must have valid direction
					if (!t.direction || (t.direction !== 'in' && t.direction !== 'out')) {
						console.warn('⚠️ Skipping transaction with invalid direction:', t)
						return false
					}
					// Must have valid amount
					if (!t.amount || Number(t.amount) <= 0) {
						console.warn('⚠️ Skipping transaction with invalid amount:', t)
						return false
					}
					// Must have account name
					if (!t.accountName || t.accountName.trim() === '') {
						console.warn('⚠️ Skipping transaction without account name:', t)
						return false
					}
					// Must have description
					if (!t.description || t.description.trim() === '') {
						console.warn('⚠️ Skipping transaction without description:', t)
						return false
					}
					return true
				}).map((t: any) => {
					// Normalize account names to standard forms
					let accountName = String(t.accountName).trim()
					const lowerName = accountName.toLowerCase()
					
					// Map variations to standard account names
					if (lowerName === 'cogs' || lowerName === 'cost of goods' || lowerName.includes('cost of goods sold')) {
						accountName = 'Cost of Goods Sold'
					} else if (lowerName === 'ar' || lowerName === 'receivable' || lowerName.includes('accounts receivable')) {
						accountName = 'Accounts Receivable'
					} else if (lowerName === 'ap' || lowerName === 'payable' || lowerName.includes('accounts payable')) {
						accountName = 'Accounts Payable'
					} else if (lowerName.includes('sales revenue') || lowerName === 'sales') {
						accountName = 'Sales Revenue'
					} else if (lowerName.includes('service revenue') || lowerName === 'service') {
						accountName = 'Service Revenue'
					} else if (lowerName === 'inventory' || lowerName === 'stock') {
						accountName = 'Inventory'
					}
					// Keep Cash, Revenue, and other names as-is
					
					return {
						date: t.date ? String(t.date) : undefined,
						description: String(t.description ?? ''),
						summary: t.summary ? String(t.summary) : undefined,
						amount: Number(t.amount ?? 0),
						direction: t.direction === 'in' ? 'in' : 'out',
						categoryType: t.categoryType,
						accountName: accountName
					}
				})
				: []

			console.log(`✓ Extracted ${validatedTransactions.length} valid transactions from ${parsed.transactions?.length || 0} total`)
			
			return {
				rawText: String(parsed.rawText ?? ''),
				translatedText: String(parsed.translatedText ?? ''),
				unknownWords: Array.isArray(parsed.unknownWords) ? parsed.unknownWords.map(String) : [],
				transactions: validatedTransactions,
			}
		} catch (e: any) {
			lastError = e
			continue
		}
	}

	throw lastError || new Error('AI request failed')
}

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { recordJournalEntry } from '@/lib/accounting'
import { parseIntents, type Intent } from '@/lib/jesseIntents'

const TZ = 'Africa/Kigali'

function kigaliDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d)
}
function kigaliStart(dateStr: string) { return new Date(`${dateStr}T00:00:00+02:00`) }
function kigaliEnd(dateStr: string)   { return new Date(`${dateStr}T23:59:59.999+02:00`) }
function shiftDays(d: Date, n: number) { return new Date(d.getTime() + n * 86400000) }

function fmt(n: number) { return Math.round(n).toLocaleString('en-RW') + ' RWF' }
function pct(part: number, total: number) {
  return total > 0 ? ((part / total) * 100).toFixed(1) + '%' : '0.0%'
}

interface Range { start: Date; end: Date; label: string }

function hasExplicitTimePeriod(q: string) {
  return /\b(today|yesterday|this\s*week|last\s*week|this\s*month|last\s*month|this\s*year|past\s+\d+\s*days?|two\s+days|three\s+days|seven\s+days)\b/i.test(q)
    || parseSpecificDate(q) !== null
}

function thisMonthRange(): Range {
  const today = kigaliDateStr()
  const [year, month] = today.split('-')
  return { start: kigaliStart(`${year}-${month}-01`), end: kigaliEnd(today), label: 'This Month' }
}

const MONTH_MAP: Record<string, number> = {
  jan:0, january:0, feb:1, february:1, mar:2, march:2,
  apr:3, april:3, may:4, jun:5, june:5, jul:6, july:6,
  aug:7, august:7, sep:8, september:8, oct:9, october:9,
  nov:10, november:10, dec:11, december:11,
}
const MONTH_PAT = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'

function parseSpecificDate(q: string): Range | null {
  const today = kigaliDateStr()
  const currentYear = Number(today.split('-')[0])
  let day: number | null = null
  let month: number | null = null
  let year = currentYear

  // "31st may", "31 may", "31st of may"
  const m1 = q.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_PAT}(?:\\s+(\\d{4}))?\\b`, 'i'))
  if (m1) { day = Number(m1[1]); month = MONTH_MAP[m1[2].slice(0,3).toLowerCase()]; if (m1[3]) year = Number(m1[3]) }

  // "may 31st", "may 31", "june 5"
  const m2 = !m1 && q.match(new RegExp(`\\b${MONTH_PAT}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\b`, 'i'))
  if (m2) { month = MONTH_MAP[m2[1].slice(0,3).toLowerCase()]; day = Number(m2[2]); if (m2[3]) year = Number(m2[3]) }

  if (day === null || month === null || day < 1 || day > 31) return null

  // If month is in the future for this year, use last year
  const specDate = new Date(year, month, day)
  const todayObj = new Date(today + 'T12:00:00')
  if (specDate > todayObj) year = currentYear - 1

  const mm = String(month + 1).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  const dateStr = `${year}-${mm}-${dd}`
  const monthName = new Date(year, month, day).toLocaleDateString('en-US', { month: 'short' })
  return { start: kigaliStart(dateStr), end: kigaliEnd(dateStr), label: `${monthName} ${day}` }
}

function parseRange(q: string): Range {
  const today = kigaliDateStr()
  const todayD = kigaliStart(today)

  // Specific date: "31st may", "may 31", "june 5th 2025", etc.
  const specific = parseSpecificDate(q)
  if (specific) return specific

  if (/\byesterday\b/i.test(q)) {
    const y = kigaliDateStr(shiftDays(todayD, -1))
    return { start: kigaliStart(y), end: kigaliEnd(y), label: 'Yesterday' }
  }
  if (/\b(past|last)\s*(2|two)\s*days?\b/i.test(q)) {
    return { start: kigaliStart(kigaliDateStr(shiftDays(todayD, -1))), end: kigaliEnd(today), label: 'Past 2 Days' }
  }
  if (/\b(past|last)\s*(3|three)\s*days?\b/i.test(q)) {
    return { start: kigaliStart(kigaliDateStr(shiftDays(todayD, -2))), end: kigaliEnd(today), label: 'Past 3 Days' }
  }
  if (/\b(past|last)\s*(7|seven)\s*days?\b/i.test(q)) {
    return { start: kigaliStart(kigaliDateStr(shiftDays(todayD, -6))), end: kigaliEnd(today), label: 'Past 7 Days' }
  }
  if (/\b(last|past)\s*week\b/i.test(q)) {
    return {
      start: kigaliStart(kigaliDateStr(shiftDays(todayD, -13))),
      end:   kigaliEnd(kigaliDateStr(shiftDays(todayD, -7))),
      label: 'Last Week',
    }
  }
  if (/\bthis\s*week\b|\bcurrent\s*week\b/i.test(q)) {
    return { start: kigaliStart(kigaliDateStr(shiftDays(todayD, -6))), end: kigaliEnd(today), label: 'This Week' }
  }
  if (/\b(last|past)\s*month\b/i.test(q)) {
    const [year, month] = today.split('-').map(Number)
    const pm = month === 1 ? 12 : month - 1
    const py = month === 1 ? year - 1 : year
    const lastDay = new Date(year, month - 1, 0).getDate()
    const startD = `${py}-${String(pm).padStart(2, '0')}-01`
    const endD   = `${py}-${String(pm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    return { start: kigaliStart(startD), end: kigaliEnd(endD), label: 'Last Month' }
  }
  if (/\bthis\s*month\b|\bcurrent\s*month\b/i.test(q)) {
    const [year, month] = today.split('-')
    return { start: kigaliStart(`${year}-${month}-01`), end: kigaliEnd(today), label: 'This Month' }
  }
  if (/\bthis\s*year\b|\bcurrent\s*year\b/i.test(q)) {
    const [year] = today.split('-')
    return { start: kigaliStart(`${year}-01-01`), end: kigaliEnd(today), label: 'This Year' }
  }
  return { start: kigaliStart(today), end: kigaliEnd(today), label: 'Today' }
}

// ── Transaction recording helpers ────────────────────────────────────────────

function extractAmount(text: string): number | null {
  const m = text.match(/\b(\d[\d,]*(?:\.\d{1,2})?)\s*(k|thousand)?\b/i)
  if (!m) return null
  const base = parseFloat(m[1].replace(/,/g, ''))
  if (isNaN(base) || base <= 0) return null
  return /\b(k|thousand)\b/i.test(m[2] ?? '') ? base * 1000 : base
}

function extractTxDate(text: string): Date {
  const now = new Date()
  if (/\byesterday\b/i.test(text)) return new Date(now.getTime() - 86400000)
  const months: Record<string, number> = {
    jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
  }
  const mth = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})\b/i)
  if (mth) {
    const month = months[mth[1].toLowerCase().slice(0, 3)]
    return new Date(now.getFullYear(), month, parseInt(mth[2]))
  }
  const d = text.match(/\bon\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i)
  if (d) return new Date(now.getFullYear(), now.getMonth(), parseInt(d[1]))
  return now
}

function classifyExpenseAccount(text: string): string {
  const t = text.toLowerCase()
  // Transport & Fuel
  if (/fuel|diesel|petrol|gas|transport(ation)?\s*(cost|fee|expense)?|delivery charge|courier|freight|shipping fee|logistics|port charges|handling fee|distribution|vehicle|driver|taxi|moto|travel/.test(t)) return 'Fuel & Transport'
  // Rent & Premises
  if (/\brent\b|office rent|premises|lease|storage fee|warehousing|packaging cost/.test(t)) return 'Rent & Premises'
  // Salaries & HR
  if (/salary|salaries|wage|wages|payroll|staff\s*pay|employee\s*pay|\bemployee\b|\bstaff\b|\bworker\b|labor|labour|bonus|overtime|commission payout|per diem|contractor pay|freelancer|allowance|reimburs|salary advance|payroll deduction|compensation|paye|internship stipend|coaching|mentoring fee/.test(t)) return 'Salaries & Wages'
  // Utilities
  if (/electric|electricity|water bill|utilities|utility|power bill/.test(t)) return 'Utilities'
  // Communication & Tech — includes POS systems and named software
  if (/telecom|phone bill|airtime|data bundle|internet|mobile data|communication|hosting fee|domain|cloud subscription|saas|api charges|server expense|it support|cybersecurity|software maintenance|tech upgrade|hardware|printer|network equipment|backup service|storage subscription|software renewal|\bpos\b|point of sale|magnify|subscription\s+fee|system\s+fee|platform\s+fee|app\s+fee/.test(t)) return 'Technology & Telecom'
  // Repairs & Maintenance
  if (/repair|maintenance|fix|technician|servicing|replacement part|oil change|tire|janitorial|cleaning expense|security expense/.test(t)) return 'Repairs & Maintenance'
  // Insurance
  if (/insurance|insure|insurance premium|deductible|risk management|safety equipment/.test(t)) return 'Insurance'
  // Marketing & Advertising
  if (/market|advertis|promotion|campaign|social media ads|google ads|facebook ads|influencer|lead generation|affiliate payout|cac|pr expense|event expense|trade show|printing cost|signage|media buying|branding|sponsorship/.test(t)) return 'Marketing & Advertising'
  // Legal & Professional
  if (/legal fee|accounting fee|audit fee|consultancy|professional service|compliance expense|licensing fee|permit fee|registration fee|renewal fee|certification fee|inspection fee|government fee|filing fee|notary|arbitration|advisory fee|due diligence/.test(t)) return 'Legal & Professional'
  // Office & Supplies
  if (/supply|supplies|stationery|office supply|material|software subscription|software license|book purchase|online course|learning material/.test(t)) return 'Office Supplies'
  // Education & Training
  if (/training|workshop|seminar|certification training|school fees|tuition|education allowance|scholarship|coaching expense|mentoring/.test(t)) return 'Training & Education'
  // Meals & Entertainment
  if (/lunch|meal|dinner|breakfast|snack|catering|food\s+expense/.test(t)) return 'Meals & Entertainment'
  // Tax
  if (/\btax\b|vat payable|withholding|paye|corporate tax|customs duty|import tax|excise|levy|compliance fee|tax penalty/.test(t)) return 'Tax Expense'
  // Cleaning & Hygiene
  if (/clean|hygiene|sanitiz|detergent/.test(t)) return 'Cleaning & Hygiene'
  // Capital Expenditure
  if (/equipment purchase|machinery|furniture|laptop purchase|computer equipment|fixed asset|capex|capital expenditure|building purchase|land acquisition|intangible asset|depreciation|vehicle purchase/.test(t)) return 'Capital Expenditure'
  // Loan & Finance
  if (/loan repayment|debt payment|installment|mortgage|overdraft|interest charged|interest payable|interest expense|bank fee|principal repayment|debt restructuring|refinancing|revolving credit|line of credit/.test(t)) return 'Loan & Finance Charges'
  // Donations & Memberships
  if (/donation made|charity expense|membership fee|subscription fee/.test(t)) return 'Donations & Memberships'
  // Refunds & Adjustments
  if (/refund issued|discount given|sales return|cash back|inventory loss|shrinkage|spoilage|write.?down|inventory write/.test(t)) return 'Refunds & Adjustments'
  // Foreign Exchange
  if (/exchange rate loss|forex|currency conversion|hedging expense|brokerage fee/.test(t)) return 'Foreign Exchange'
  // Owner Drawings
  if (/dividend payout|drawings|owner withdrawal/.test(t)) return 'Owner Drawings'
  // Inventory
  if (/stock purchase|inventory purchase|goods received|raw material|stock acquired|procurement cost|sourcing expense/.test(t)) return 'Inventory Purchases'
  // Petty Cash
  if (/petty cash|float|till/.test(t)) return 'Petty Cash'
  return 'General Expense'
}

function classifyIncomeAccount(text: string): string {
  const t = text.toLowerCase()
  // Dish / food sales — "sold a dish", "sold burger", "sold a meal"
  if (/\b(sold\s+a?\s*)?(dish|meal|food|drink|burger|pizza|chicken|rice|beef|fish|juice|cocktail|coffee|tea|beer|wine|soda|menu\s+item)\b/.test(t)) return 'Sales Revenue'
  if (/service income|consulting income|consultancy|professional fee|advisory/.test(t)) return 'Service Revenue'
  if (/interest income|interest earned/.test(t)) return 'Interest Income'
  if (/rental income|rent income/.test(t)) return 'Rental Income'
  if (/commission earned|royalty income/.test(t)) return 'Commission & Royalties'
  if (/dividend income|investment income|capital gain|trading income|portfolio/.test(t)) return 'Investment Income'
  if (/grant received|fundraising income|crowdfunding|donation received|claim received|insurance payout/.test(t)) return 'Grants & Other Income'
  if (/exchange rate gain|forex gain|currency gain/.test(t)) return 'Foreign Exchange Gain'
  if (/refund received|cashback|settlement received|accrued income|installment received/.test(t)) return 'Other Income'
  if (/loan received|financing received|startup capital|seed funding|venture|angel investment|equity funding|capital injection|owner investment|shareholder/.test(t)) return 'Owner & Financing'
  if (/subscription revenue/.test(t)) return 'Subscription Revenue'
  return 'Sales Revenue'
}

function extractTxPaymentMethod(text: string): string {
  if (/\bmomo\b|\bmobile\s*money\b/i.test(text)) return 'MoMo'
  if (/\bbank\b|\btransfer\b|\bcheque\b|\bcheck\b|\bwire\b/i.test(text)) return 'Bank'
  if (/\bcard\b|\bvisa\b|\bmastercard\b/i.test(text)) return 'Card'
  return 'Cash'
}

interface TxItem {
  direction: 'in' | 'out'
  amount: number
  date: Date
  accountName: string
  paymentMethod: string
  description: string
}

const TX_STOP = /\b(record|log|add|post|enter|a|an|transaction|entry|i|we|our|paid|received|spent|bought|purchased|earned|sold|for|from|by|via|using|with|on|the|to|of|and|in|at|today|yesterday|this|month|past|date|cash|momo|bank|card|cheque|rwf|frw)\b/gi

function parseSingleTransaction(seg: string): TxItem | null {
  const amount = extractAmount(seg)
  if (!amount) return null

  const date = extractTxDate(seg)
  const paymentMethod = extractTxPaymentMethod(seg)
  const isIncome = /\b(received|earned|income|revenue|sold|customer\s+paid|client\s+paid|payment\s+from|got\s+paid)\b/i.test(seg)
  const direction: 'in' | 'out' = isIncome ? 'in' : 'out'
  const accountName = direction === 'in' ? classifyIncomeAccount(seg) : classifyExpenseAccount(seg)

  // Extract dish/item name from "the dish is X" or "dish: X" patterns
  const dishMatch = seg.match(/(?:the\s+)?dish\s+is\s+([^,.]+)/i) || seg.match(/dish[:\s]+([^,.]+)/i)
  const namedItem = dishMatch?.[1]?.trim() ?? null

  const description = namedItem || (seg
    .replace(TX_STOP, ' ')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/gi, '')
    .replace(/\bon\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?\b/gi, '')
    .replace(/[\d,]+\s*(k|thousand|rwf|frw)?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,.\-\s]+|[,.\-\s]+$/g, '')
    || (direction === 'in' ? 'Income' : 'General Expense'))

  return { direction, amount, date, accountName, paymentMethod, description }
}

function parseTransactionSegments(q: string): string[] {
  const byComma = q.split(
    /,\s*(?=(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}(?:st|nd|rd|th)?\s|\bpaid\b|\breceived\b|\bbought\b|\bspent\b|\brecord\b|\bfuel\b|\bdiesel\b|\brent\b|\bsalary\b|\brepair\b))/i
  )
  const result: string[] = []
  for (const seg of byComma) {
    const sub = seg.split(/\s+and\s+(?=[\d,]+\s*(k\b)?|\bpaid\b|\breceived\b|\bbought\b|\bspent\b)/i)
    result.push(...sub.map(s => s.trim()).filter(s => s.length > 3))
  }
  return result
}

// ── Branch name/code fuzzy-matcher ───────────────────────────────────────────
// Matches the question against every branch's current name AND code so that
// renaming a branch (or using its short code like BAR / GRL) still works.
function resolveBranch(q: string, branches: { id: string; name: string; code: string }[]): { id: string; name: string } | null {
  const STOP = new Set(['and', 'the', 'for', 'with', 'our'])
  const norm = (s: string) =>
    s.toLowerCase()
      .replace(/[&+]/g, ' and ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const qn = norm(q)
  // Also check raw lowercase for short-code matching (e.g. "bar", "grl")
  const qRaw = q.toLowerCase()
  let best: { id: string; name: string } | null = null
  let bestScore = 0
  for (const b of branches) {
    // 1. Exact normalised name match
    const bn = norm(b.name)
    if (qn.includes(bn)) return b
    // 2. Short code match — word-boundary so "bar" in "bar & grill" matches BAR
    //    but not accidentally inside another word
    const code = b.code.toLowerCase()
    if (code && new RegExp(`\\b${code}\\b`).test(qRaw)) return b
    // 3. Fuzzy word-overlap on name
    const words = bn.split(' ').filter(w => w.length > 2 && !STOP.has(w))
    if (words.length === 0) continue
    const hits = words.filter(w => qn.includes(w)).length
    const score = hits / words.length
    if (hits >= 1 && score > bestScore) { bestScore = score; best = b }
  }
  return bestScore >= 0.4 ? best : null
}

// ─────────────────────────────────────────────────────────────────────────────

// Intent parsing lives in lib/jesseIntents.ts so it can be tested directly.

// ── Follow-up chip suggestions per intent ────────────────────────────────────
function getFollowUps(intents: Intent[], branchCount: number): string[] {
  const has = (i: Intent) => intents.includes(i)
  if (has('capabilities') || has('acknowledgement')) {
    return ["How's business today?", "Today's revenue?", 'Any low stock?']
  }
  if (has('catchup') || (has('greeting') && intents.length === 1)) {
    return ["Today's revenue?", 'Any pending orders?', 'Low stock alert?']
  }
  if (has('why')) {
    return ['Compare this week vs last week', 'Revenue by station', 'Show top selling dishes']
  }
  if (has('trends')) {
    return ['This month vs last month', 'Which station is growing?', "What's profit this week?"]
  }
  if (has('branch_comparison')) {
    return ['Profit by station', 'Expenses by station', 'Top dishes this month?']
  }
  if (has('profit')) {
    return branchCount > 1
      ? ['Which station has best margin?', "What's the food cost this period?", 'Compare to last week']
      : ["What's the food cost?", 'Top dishes this month?', 'Compare to last week']
  }
  if (has('revenue')) {
    return branchCount > 1
      ? ['Revenue by station', 'What are the top dishes?', 'Why did revenue change?']
      : ['What about expenses?', 'Top dishes this period?', 'Why did revenue change?']
  }
  if (has('expenses')) {
    return ["What's the profit?", 'Revenue vs expenses', 'Compare to last week']
  }
  if (has('orders')) {
    return ["What's the revenue?", 'Average order value?', 'Pending orders right now?']
  }
  if (has('top_dishes')) {
    return ['Revenue from top dish this month?', 'Which station sells it most?', "What's the profit this month?"]
  }
  if (has('low_stock')) {
    return ['What should I restock first?', 'Expenses this week?', 'How much did we spend on inventory?']
  }
  if (has('payment')) {
    return ['Total revenue this period?', "What's the profit?", 'Revenue by station']
  }
  if (has('record_transaction')) {
    return ["Today's expenses?", "What's today's profit?", 'Revenue this week?']
  }
  if (has('waste')) {
    return ['How does waste compare to last week?', "What's the food cost?", 'Top wasted items?']
  }
  if (has('stock_level')) {
    return ['Any low stock items?', 'What should I restock first?', 'Inventory expenses this month?']
  }
  if (has('avg_order')) {
    return ["What's the revenue?", 'Top dishes this period?', 'Pending orders now?']
  }
  if (has('pending_orders')) {
    return ["What's today's revenue?", 'Average order value?', 'Top dishes today?']
  }
  return ["Today's revenue?", 'Pending orders?', 'Any low stock?']
}

function parsePaymentFilter(q: string): string | null {
  if (/\bmomo\b|\bmobile\s*money\b/i.test(q)) return 'MoMo'
  if (/\bcash\b/i.test(q)) return 'Cash'
  if (/\bbank\b/i.test(q)) return 'Bank'
  if (/\bcheque\b|\bcheck\b/i.test(q)) return 'Cheque'
  if (/\bcard\b|\bvisa\b|\bmastercard\b/i.test(q)) return 'Card'
  if (/\bcredit\b/i.test(q)) return 'Credit'
  return null
}

function parseIngredientName(q: string): string | null {
  const STOP = /\b(how|many|much|kgs?|kg|grams?|g|litres?|liters?|l|units?|pieces?|pcs?|bottles?|cans?|bags?|of|do|we|have|is|left|remaining|available|in|stock|level|quantity|any|some|the|a|an|please|tell|me|check|what|show)\b/gi
  const patterns = [
    /\bof\s+([a-z][a-z\s''-]+?)\s+(?:do\s+we\s+have|in\s+stock|left|remaining|available)\b/i,
    /\bhow\s+much\s+([a-z][a-z\s''-]+?)\s+(?:do\s+we\s+have|is\s+(?:there\s+)?left|remaining|available|in\s+stock)\b/i,
    /\b(?:stock\s+(?:level\s+)?of|quantity\s+of)\s+([a-z][a-z\s''-]+?)(?:\s*[?.]|$)/i,
    /\bdo\s+we\s+have\s+(?:any\s+)?([a-z][a-z\s''-]+?)(?:\s+(?:left|in\s+stock|remaining)|[?.]|$)/i,
    /\b([a-z][a-z\s''-]+?)\s+(?:in\s+stock|stock\s+level|stock)\b/i,
  ]
  for (const p of patterns) {
    const m = q.match(p)
    if (m?.[1]) {
      const name = m[1].replace(STOP, ' ').replace(/\s+/g, ' ').trim()
      if (name.length >= 2) return name
    }
  }
  return null
}

function parseDishName(q: string): string | null {
  const STOP = /\b(how|much|many|did|we|sell|sold|make|made|revenue|sales|income|from|of|today|yesterday|this|last|week|month|year|past|days?|what|is|our|the|a|an|in|have|any|do|were|best|seller|selling|popular|most|drink|dish|dishes|ordered)\b/gi
  const patterns = [
    // "revenue/sales/income from [dish]" or "made from [dish]"
    /\b(?:revenue|sales|income|made|earned)\s+from\s+([a-z][a-z\s''-]+?)(?:\s+(?:today|yesterday|this|last|past)|[?.]|$)/i,
    // "how much did we make from [dish]" / "how much from [dish]"
    /\bfrom\s+([a-z][a-z\s''-]+?)(?:\s+(?:today|yesterday|this|last|past|in|did|do)|[?.]|$)/i,
    // "how many [dish] did we sell / sold"
    /\bhow\s+many\s+([a-z][a-z\s''-]+?)\s+(?:did\s+we\s+sell|sold|were\s+sold|have\s+we\s+sold)\b/i,
    // "[dish] sales this week" / "[dish] revenue today"
    /\b([a-z][a-z\s''-]{2,}?)\s+(?:sales|revenue)\s+(?:today|yesterday|this|last|past)\b/i,
  ]
  for (const p of patterns) {
    const m = q.match(p)
    if (m?.[1]) {
      const name = m[1].replace(STOP, ' ').replace(/\s+/g, ' ').trim()
      if (name.length >= 2) return name
    }
  }
  return null
}

// ── Comparison period helper ─────────────────────────────────────────────────
function getPreviousRange(range: Range): Range | null {
  const todayStr = kigaliDateStr()
  const todayD   = kigaliStart(todayStr)
  if (range.label === 'Today') {
    const y = kigaliDateStr(shiftDays(todayD, -1))
    return { start: kigaliStart(y), end: kigaliEnd(y), label: 'Yesterday' }
  }
  if (range.label === 'Yesterday') {
    const d = kigaliDateStr(shiftDays(todayD, -2))
    return { start: kigaliStart(d), end: kigaliEnd(d), label: 'Day before' }
  }
  if (range.label === 'This Week' || range.label === 'Past 7 Days') {
    return {
      start: kigaliStart(kigaliDateStr(shiftDays(todayD, -13))),
      end:   kigaliEnd(kigaliDateStr(shiftDays(todayD, -7))),
      label: 'Previous 7 days',
    }
  }
  if (range.label === 'Last Week') {
    return {
      start: kigaliStart(kigaliDateStr(shiftDays(todayD, -20))),
      end:   kigaliEnd(kigaliDateStr(shiftDays(todayD, -14))),
      label: 'Week before',
    }
  }
  if (range.label === 'This Month') {
    const [year, month] = todayStr.split('-').map(Number)
    const pm = month === 1 ? 12 : month - 1
    const py = month === 1 ? year - 1 : year
    const lastDay = new Date(year, month - 1, 0).getDate()
    return {
      start: kigaliStart(`${py}-${String(pm).padStart(2,'0')}-01`),
      end:   kigaliEnd(`${py}-${String(pm).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`),
      label: 'Last Month',
    }
  }
  if (range.label === 'Last Month') {
    const [year, month] = todayStr.split('-').map(Number)
    const pm1 = month === 1 ? 12 : month - 1
    const py1 = month === 1 ? year - 1 : year
    const pm2 = pm1 === 1 ? 12 : pm1 - 1
    const py2 = pm1 === 1 ? py1 - 1 : py1
    const lastDay = new Date(py1, pm1 - 1, 0).getDate()
    return {
      start: kigaliStart(`${py2}-${String(pm2).padStart(2,'0')}-01`),
      end:   kigaliEnd(`${py1}-${String(pm1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`),
      label: 'Month before',
    }
  }
  if (range.label === 'This Year') {
    const [year] = todayStr.split('-')
    const prevYear = Number(year) - 1
    return { start: kigaliStart(`${prevYear}-01-01`), end: kigaliEnd(`${prevYear}-12-31`), label: 'Last Year' }
  }
  return null
}

function dSign(current: number, previous: number): string {
  if (previous <= 0) return ''
  const d = ((current - previous) / previous) * 100
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`
}
function dIcon(current: number, previous: number): '::TrendingUp::' | '::TrendingDown::' | '' {
  if (previous <= 0) return ''
  return current >= previous ? '::TrendingUp::' : '::TrendingDown::'
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId) return NextResponse.json({ error: 'No restaurant found' }, { status: 400 })

  const { restaurantId } = context

  const body = await req.json().catch(() => null)

  // ── Excel / CSV import ────────────────────────────────────────────────────────
  if (Array.isArray(body?.importRows) && body.importRows.length > 0) {
    return NextResponse.json({
      answer: `::AlertTriangle:: **Excel import is temporarily paused** while we improve it.\n\n  Check back soon — it will be back shortly.`,
      period: 'N/A', intents: [], followUps: ["Today's revenue?", "Record a transaction", "Any low stock?"], source: 'restaurant-db',
    })
    const importRows = body.importRows as Record<string, unknown>[]
    const fileName: string = body.fileName ?? 'file'
    const explicitBranchId: string | null = body.branchId ?? null
    const explicitBranchName: string | null = body.branchName ?? null

    // Multi-branch check — ask which branch before recording
    const branches = await prisma.branch.findMany({
      where: { restaurantId, isActive: true },
      select: { id: true, name: true, isMain: true },
      orderBy: { isMain: 'desc' },
    })
    if (branches.length > 1 && !explicitBranchId && !explicitBranchName) {
      return NextResponse.json({
        answer: [
          `::BarChart2:: I see **${branches.length} branches** in this restaurant.`,
          ``,
          `Which station should I record the **${importRows.length} rows** from **${fileName}** to?`,
        ].join('\n'),
        period: 'N/A',
        intents: ['import_branch_select'],
        followUps: branches.map(b => `Record to ${b.name}`),
        needsBranch: true,
        source: 'restaurant-db',
      })
    }

    // Resolve branch ID from name if provided
    let resolvedBranchId: string | null = explicitBranchId
    if (!resolvedBranchId && explicitBranchName) {
      const branchName = explicitBranchName as string
      const match = branches.find(b => b.name.toLowerCase().includes(branchName.toLowerCase()) || branchName.toLowerCase().includes(b.name.toLowerCase()))
      resolvedBranchId = match?.id ?? (branches.find(b => b.isMain)?.id ?? branches[0]?.id ?? null)
    }
    if (!resolvedBranchId) {
      resolvedBranchId = branches.find(b => b.isMain)?.id ?? branches[0]?.id ?? null
    }

    const allKeys = Object.keys(importRows[0] ?? {})

    // Flexible column finder — exact match first, then partial/contains match
    function col(row: Record<string, unknown>, ...names: string[]): string {
      const lowerKeys = allKeys.map(k => k.trim().toLowerCase())
      for (const name of names) {
        const nl = name.toLowerCase()
        // Exact match
        const exactIdx = lowerKeys.indexOf(nl)
        if (exactIdx !== -1) {
          const v = String(row[allKeys[exactIdx]] ?? '').trim()
          if (v !== '') return v
        }
        // Contains match (e.g. "unit cost" inside "unit cost (rwf)")
        const containsIdx = lowerKeys.findIndex(k => k.includes(nl) || nl.includes(k))
        if (containsIdx !== -1) {
          const v = String(row[allKeys[containsIdx]] ?? '').trim()
          if (v !== '') return v
        }
      }
      return ''
    }

    // ── 400-column keyword library ────────────────────────────────────────────
    const AMOUNT_COLS = [
      // Direct amount
      'amount','total','subtotal','net amount','gross amount','value','sum','balance',
      'running balance','closing balance','line total','net payable','net pay','gross pay',
      // Debit/Credit
      'debit','credit','dr','cr','cash out','cash in','inflow','outflow',
      // Petty cash
      'float amount','replenishment amount','till balance','cash count',
      // Payroll
      'basic salary','total earnings','total deductions','overtime pay','bonus','commission',
      'allowance','transport allowance','housing allowance','meal allowance',
      'paye','tax deduction','pension','nssf','health insurance','loan deduction','advance deduction',
      // AP/AR
      'invoice amount','amount paid','amount outstanding','amount invoiced','amount received',
      'balance due','discount allowed','early payment discount','net payable','credit note',
      'bad debt','write off amount','prepayment amount','deposit received','refund issued',
      // Fixed assets
      'purchase price','cost of asset','annual depreciation','monthly depreciation',
      'accumulated depreciation','net book value','residual value','salvage value',
      'disposal proceeds','gain on disposal','loss on disposal','insurance value',
      // Sales
      'vat amount','total before tax','total after tax','net sales','cost of goods sold',
      'gross profit','discount','delivery fee','refund','return amount','commission amount',
      // Budget
      'budget amount','actual amount','variance','forecast amount','prior year actual',
      'ytd budget','ytd actual','ytd variance','monthly budget','monthly actual',
      'committed amount','available budget',
      // Tax
      'withholding amount','paye amount','taxable amount','exempt amount','customs duty',
      'penalty amount','tax deduction',
      // Loans
      'loan amount','monthly installment','principal paid','interest paid',
      'principal outstanding','total repaid','penalty amount',
      // Forex
      'foreign amount','local equivalent','forex gain','forex loss','conversion fee',
    ]

    const DESCRIPTION_COLS = [
      // General
      'description','narration','particulars','details','notes','memo','remarks',
      'comments','explanation','purpose','narrative','remark','note',
      // Item
      'item name','item','product name','product','ingredient','material','name',
      'asset name','service','service name','account name',
      // Petty cash
      'expense category','purpose of payment','reason','nature',
      // AR/AP
      'supplier name','vendor name','customer name','client name',
      // Payroll
      'employee name','staff name','position','job title','department',
      // Sales
      'product / service','sales channel','salesperson',
      // Budget
      'budget code','cost centre','programme','fund','activity','budget holder','justification',
      // Fixed assets
      'asset category','depreciation method','asset location','asset condition','manufacturer','model',
      // Tax
      'tax type','tax code','vat code',
      // Loans
      'loan reference','lender name','collateral','guarantor',
    ]

    const DATE_COLS = [
      'date','transaction date','entry date','posting date','value date','due date',
      'payment date','invoice date','receipt date','sale date','order date',
      'purchase date','disposal date','pay date','filing date','next payment date',
      'period','month','clearing date','settlement date','cleared date',
      'last payment date','follow up date','warranty expiry','expiry date',
      'next service date','last service date','statement date',
    ]

    const TYPE_COLS = [
      'type','transaction type','entry type','category','class','nature','direction',
      'sign','flow','income','expense','transfer',
    ]

    const PAYMENT_COLS = [
      'payment method','mode of payment','paid by','paid via','payment mode',
      'payment','method','mode','bank name','account no','settled via',
    ]

    const COST_COLS = [
      'unit cost','cost','purchase cost','buying price','buy price','price per unit',
      'standard cost','average cost','fifo cost','cost price',
    ]

    const QTY_COLS = [
      'quantity bought','quantity received','quantity sold','quantity issued',
      'quantity on hand','quantity','qty','qty bought','units','count','pcs',
      'no.','number','pieces','amount bought',
    ]

    const PRICE_COLS = [
      'unit price','selling price','sale price','market price','price',
      'retail price','wholesale price',
    ]

    // Detect inventory purchase format once before looping
    const isInventoryFile =
      allKeys.some(k => /\b(cost|price)\b/i.test(k)) &&
      allKeys.some(k => /\b(qty|quantity|units?|pieces?|pcs)\b/i.test(k))

    const lines: string[] = []
    let successCount = 0
    let skipCount = 0
    const resultLines: string[] = []

    // Parse all rows first (CPU-only, fast) then batch DB inserts
    type ParsedRow = { amount: number; description: string; date: Date; direction: 'in' | 'out'; accountName: string; paymentMethod: string }
    const parsedRows: ParsedRow[] = []

    for (const row of importRows) {
      let amount = 0
      const amountRaw = col(row, ...AMOUNT_COLS)
      if (amountRaw) {
        amount = parseFloat(String(amountRaw).replace(/[,\s]/g, ''))
      } else {
        const costRaw  = col(row, ...COST_COLS)
        const qtyRaw   = col(row, ...QTY_COLS)
        const priceRaw = col(row, ...PRICE_COLS)
        const cost  = parseFloat(String(costRaw).replace(/[,\s]/g, ''))
        const qty   = parseFloat(String(qtyRaw).replace(/[,\s]/g, ''))
        const price = parseFloat(String(priceRaw).replace(/[,\s]/g, ''))
        if (!isNaN(cost) && cost > 0 && !isNaN(qty) && qty > 0) amount = cost * qty
        else if (!isNaN(price) && price > 0 && !isNaN(qty) && qty > 0) amount = price * qty
      }
      if (!amount || isNaN(amount) || amount <= 0) { skipCount++; continue }

      const description = col(row, ...DESCRIPTION_COLS)
      let date = new Date()
      const dateRaw = col(row, ...DATE_COLS)
      if (dateRaw) {
        if (/^\d{5}$/.test(dateRaw.replace(/\s/g, ''))) {
          date = new Date((parseInt(dateRaw) - 25569) * 86400 * 1000)
        } else {
          const parsed = new Date(dateRaw)
          if (!isNaN(parsed.getTime())) date = parsed
        }
      }

      const typeRaw = col(row, ...TYPE_COLS).toLowerCase()
      let direction: 'in' | 'out'
      if (/income|revenue|\bin\b|credit|received|sales|earning|inflow|cash\s*in/.test(typeRaw)) direction = 'in'
      else if (/expense|\bout\b|debit|paid|cost|payment|outflow|cash\s*out/.test(typeRaw)) direction = 'out'
      else direction = /\b(received|earned|income|revenue|sales|sold|customer\s+paid|got\s+paid|money\s+in|cash\s+in|inflow)\b/i.test(description) ? 'in' : 'out'

      const prompt = `${description} ${typeRaw}`
      const accountName = direction === 'in'
        ? classifyIncomeAccount(prompt)
        : (isInventoryFile ? 'Inventory Purchases' : classifyExpenseAccount(prompt))

      const pmRaw = col(row, ...PAYMENT_COLS)
      let paymentMethod = 'Cash'
      if (/momo|mobile\s*money|mtn|airtel\s*money/i.test(pmRaw)) paymentMethod = 'MoMo'
      else if (/bank|transfer|cheque|check|wire|rtgs|eft|swift|direct\s*debit|standing\s*order/i.test(pmRaw)) paymentMethod = 'Bank'
      else if (/card|visa|mastercard|pos|debit\s*card|credit\s*card/i.test(pmRaw)) paymentMethod = 'Card'

      parsedRows.push({ amount, description, date, direction, accountName, paymentMethod })
    }

    // Batch DB inserts — 15 concurrent at a time to avoid overwhelming the connection pool
    const BATCH = 15
    for (let i = 0; i < parsedRows.length; i += BATCH) {
      const chunk = parsedRows.slice(i, i + BATCH)
      const results = await Promise.allSettled(chunk.map(r =>
        recordJournalEntry(prisma, {
          restaurantId,
          branchId: resolvedBranchId ?? undefined,
          date: r.date,
          description: r.description || r.accountName,
          amount: r.amount,
          direction: r.direction,
          accountName: r.accountName,
          categoryType: r.direction === 'in' ? 'income' : 'expense',
          paymentMethod: r.paymentMethod,
        })
      ))
      results.forEach((result, idx) => {
        const r = chunk[idx]
        if (result.status === 'fulfilled') {
          const arrow = r.direction === 'in' ? '::TrendingUp::' : '::TrendingDown::'
          const dateLabel = r.date.toLocaleDateString('en-RW', { day: 'numeric', month: 'short', year: '2-digit' })
          resultLines.push(`  ${arrow} **${fmt(r.amount)}** · ${r.accountName} · ${r.paymentMethod} · ${dateLabel}${r.description ? ` · ${r.description.slice(0, 45)}` : ''}`)
          successCount++
        } else {
          resultLines.push(`  ::XCircle:: Skipped: ${r.description || r.accountName} — ${fmt(r.amount)}`)
          skipCount++
        }
      })
    }

    const recordedBranchName = resolvedBranchId
      ? (branches.find(b => b.id === resolvedBranchId)?.name ?? null)
      : null
    lines.push(`**Excel Import — ${fileName}** · ${importRows.length} row${importRows.length !== 1 ? 's' : ''}${recordedBranchName ? ` · ${recordedBranchName}` : ''}`)
    lines.push(...resultLines.slice(0, 50))
    if (resultLines.length > 50) lines.push(`  ...and ${resultLines.length - 50} more entries`)
    lines.push(`  ─`)
    if (successCount > 0) {
      lines.push(`  ::CheckCircle:: **${successCount} transaction${successCount !== 1 ? 's' : ''} recorded**${recordedBranchName ? ` to **${recordedBranchName}**` : ''} and visible in the Journal.`)
    }
    if (skipCount > 0) {
      lines.push(`  ::AlertTriangle:: ${skipCount} row${skipCount !== 1 ? 's' : ''} skipped (missing or invalid amount).`)
    }

    return NextResponse.json({ answer: lines.join('\n'), period: 'Import', intents: ['record_transaction'], followUps: ["Today's expenses?", "What's today's profit?", 'Revenue this week?'], source: 'restaurant-db' })
  }

  const question = ((body?.question ?? '') as string).trim()
  if (!question) return NextResponse.json({ error: 'No question provided' }, { status: 400 })
  const prevQuestion: string = ((body?.context?.prevQuestion ?? '') as string).trim()
  const prevAnswer: string = ((body?.context?.prevAnswer ?? '') as string).trim()

  // ── Creator / Identity ────────────────────────────────────────────────────────
  if (/\b(who\s+(made|built|created|programmed|developed|trained|wrote|designed)\s+(you|jesse)|who\s+are\s+you\b|what\s+are\s+you\b|your\s+(creator|developer|maker|author|owner)|made\s+by|built\s+by|created\s+by|who\s+is\s+(your|jesse.?s)\s+(creator|developer|maker)|who\s+owns\s+you|where\s+do\s+you\s+come\s+from)\b/i.test(question)) {
    return NextResponse.json({
      answer: [
        `I'm **Jesse** ⚡ — your restaurant intelligence assistant.`,
        ``,
        `**Magnify** is my creator — specifically **Axel K. Gakuba**.`,
        `I was built to help restaurant managers track revenue, expenses, inventory, and make smarter business decisions in real time.`,
      ].join('\n'),
      period: 'N/A', intents: ['identity'], followUps: ["How's business today?", "Today's revenue?", 'Any low stock?'], source: 'restaurant-db',
    })
  }

  // ── Casual / Conversational ───────────────────────────────────────────────────
  if (/^(wow|nice|great|good|cool|awesome|amazing|perfect|excellent|brilliant|superb|wonderful|fantastic|incredible|love\s+it|keep\s+it\s+up|good\s+work|well\s+done|not\s+bad|sounds\s+good|fair\s+enough|right\s+on|cheers|i\s+appreciate\s+(it|that)|that\s+helps|good\s+to\s+know|makes\s+sense|i\s+see|understood|got\s+it|noted|sure|okay|ok|alright|yep|yeah|nope|nah|haha+|lol|interesting)[\s!.]*$/i.test(question.trim())) {
    const replies = [
      `Glad to hear it! 😊 Anything else you'd like to check?`,
      `Happy to help! Let me know if you need any numbers or reports.`,
      `Anytime! Want to check revenue, expenses, or inventory?`,
      `Good! Ask me anything — sales, stock levels, profit, you name it.`,
      `👍 Ready when you are. What do you need next?`,
    ]
    return NextResponse.json({
      answer: replies[Math.floor(Date.now() / 1000) % replies.length],
      period: 'N/A', intents: ['conversational'], followUps: ["Today's revenue?", 'Any pending orders?', 'Low stock alert?'], source: 'restaurant-db',
    })
  }

  // Fetch this restaurant's branches (name + code) so Jesse can filter by either
  const allBranches = await prisma.branch.findMany({
    where: { restaurantId, isActive: true },
    select: { id: true, name: true, code: true },
    orderBy: { name: 'asc' },
  })

  const range        = parseRange(question)
  const intents      = parseIntents(question)
  const pmFilter     = parsePaymentFilter(question)
  const targetBranch = resolveBranch(question, allBranches)
  const branchFilter = targetBranch ? { branchId: targetBranch.id } : {}
  const branchLabel  = targetBranch ? targetBranch.name : 'All Stations'
  const lines: string[] = []

  // ── CAT 1: CATCH-UP — executive business snapshot ────────────────────────────
  if (intents.includes('catchup')) {
    const todayStr   = kigaliDateStr()
    const todayStart = kigaliStart(todayStr)
    const todayEnd   = kigaliEnd(todayStr)
    const yStr       = kigaliDateStr(shiftDays(todayStart, -1))

    const [todaySales, ySales, pendingOrders, allStock, todayOrders] = await Promise.all([
      prisma.dishSale.findMany({
        where: { restaurantId, saleDate: { gte: todayStart, lte: todayEnd } },
        select: { totalSaleAmount: true, calculatedFoodCost: true, paymentMethod: true, branchId: true, branch: { select: { name: true } }, dish: { select: { name: true } } },
      }),
      prisma.dishSale.findMany({
        where: { restaurantId, saleDate: { gte: kigaliStart(yStr), lte: kigaliEnd(yStr) } },
        select: { totalSaleAmount: true },
      }),
      prisma.restaurantOrder.findMany({
        where: { restaurantId, status: { in: ['PENDING', 'OPEN'] } },
        select: { totalAmount: true, branch: { select: { name: true } } },
      }),
      prisma.inventoryItem.findMany({ where: { restaurantId }, select: { name: true, quantity: true, reorderLevel: true, unit: true } }),
      prisma.restaurantOrder.findMany({
        where: { restaurantId, createdAt: { gte: todayStart, lte: todayEnd }, status: { in: ['COMPLETED', 'PAID'] } },
        select: { totalAmount: true },
      }),
    ])

    const todayRev  = todaySales.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
    const todayCogs = todaySales.reduce((s, x) => s + (x.calculatedFoodCost ?? 0), 0)
    const todayProfit = todayRev - todayCogs
    const yRev      = ySales.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
    const revTrend  = yRev > 0 ? ((todayRev - yRev) / yRev) * 100 : null
    const lowStock  = allStock.filter(i => i.quantity <= (i.reorderLevel ?? 0))
    const pendingVal = pendingOrders.reduce((s, o) => s + (o.totalAmount ?? 0), 0)
    const avgOrder  = todayOrders.length > 0 ? todayOrders.reduce((s, o) => s + (o.totalAmount ?? 0), 0) / todayOrders.length : 0

    // Top dish today
    const dishMap: Record<string, { name: string; rev: number; qty: number }> = {}
    for (const s of todaySales) {
      const k = s.dish.name
      if (!dishMap[k]) dishMap[k] = { name: k, rev: 0, qty: 0 }
      dishMap[k].rev += s.totalSaleAmount ?? 0
    }
    const topDish = Object.values(dishMap).sort((a, b) => b.rev - a.rev)[0]

    // Top branch today
    const branchMap: Record<string, { name: string; rev: number }> = {}
    for (const s of todaySales) {
      if (!branchMap[s.branchId]) branchMap[s.branchId] = { name: s.branch.name, rev: 0 }
      branchMap[s.branchId].rev += s.totalSaleAmount ?? 0
    }
    const branchRanked = Object.values(branchMap).sort((a, b) => b.rev - a.rev)
    const topBranch = branchRanked[0]

    // Payment method dominant
    const pmMap: Record<string, number> = {}
    for (const s of todaySales) { const m = s.paymentMethod ?? 'Cash'; pmMap[m] = (pmMap[m] ?? 0) + (s.totalSaleAmount ?? 0) }
    const topPm = Object.entries(pmMap).sort((a, b) => b[1] - a[1])[0]

    const hour = new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })
    const h    = parseInt(hour, 10)
    const greet = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening'

    lines.push(`::Zap:: **${greet}! Business Snapshot — Today**`)
    lines.push(``)

    // ── Revenue ──
    lines.push(`**::Banknote:: Revenue**`)
    lines.push(`  Total: **${fmt(todayRev)}**`)
    if (revTrend !== null) {
      const icon = revTrend >= 0 ? '::TrendingUp::' : '::TrendingDown::'
      lines.push(`  ${icon} ${revTrend >= 0 ? '+' : ''}${revTrend.toFixed(1)}% vs yesterday (${fmt(yRev)})`)
    }
    if (todayOrders.length > 0) lines.push(`  ${todayOrders.length} completed order${todayOrders.length !== 1 ? 's' : ''} · Avg: **${fmt(avgOrder)}**`)
    if (topPm) lines.push(`  Most payments via **${topPm[0]}** (${pct(topPm[1], todayRev)})`)
    lines.push(``)

    // ── Profit ──
    if (todayRev > 0) {
      lines.push(`**::Target:: Profit**`)
      lines.push(`  **${fmt(todayProfit)}** (${pct(todayProfit, todayRev)} margin)`)
      lines.push(`  Food cost: ${fmt(todayCogs)} · ${pct(todayCogs, todayRev)} of revenue`)
      lines.push(``)
    }

    // ── Operations ──
    lines.push(`**::Clock:: Operations**`)
    if (pendingOrders.length === 0) {
      lines.push(`  No pending orders right now`)
    } else {
      lines.push(`  **${pendingOrders.length} pending order${pendingOrders.length !== 1 ? 's'  : ''}** · ${fmt(pendingVal)} in queue`)
      if (allBranches.length > 1) {
        const pMap: Record<string, number> = {}
        for (const o of pendingOrders) { const b = o.branch?.name ?? 'Unknown'; pMap[b] = (pMap[b] ?? 0) + 1 }
        const pTop = Object.entries(pMap).sort((a, b) => b[1] - a[1]).slice(0, 2)
        pTop.forEach(([b, c]) => lines.push(`  ${b}: ${c} order${c !== 1 ? 's' : ''}`))
      }
    }
    if (allBranches.length > 1) lines.push(`  ${allBranches.length} branches active`)
    lines.push(``)

    // ── Stock ──
    if (lowStock.length === 0) {
      lines.push(`**::CheckCircle:: Stock** — All levels OK`)
    } else {
      lines.push(`**::AlertTriangle:: Stock Alerts — ${lowStock.length} item${lowStock.length !== 1 ? 's' : ''} low**`)
      lowStock.slice(0, 4).forEach(i => lines.push(`  • **${i.name}**: ${Number(i.quantity.toFixed(2))} ${(i as any).unit ?? ''} (reorder at ≤${i.reorderLevel})`))
      if (lowStock.length > 4) lines.push(`  ...and ${lowStock.length - 4} more`)
    }
    lines.push(``)

    // ── Best performers ──
    if (topDish || (topBranch && allBranches.length > 1)) {
      lines.push(`**::Flame:: Best Performers Today**`)
      if (topDish) lines.push(`  ::ChefHat:: Top dish: **${topDish.name}** — ${fmt(topDish.rev)}`)
      if (topBranch && allBranches.length > 1) {
        const share = pct(topBranch.rev, todayRev)
        lines.push(`  ::Star:: Top branch: **${topBranch.name}** — ${fmt(topBranch.rev)} (${share} of revenue)`)
      }
      lines.push(``)
    }

    // ── Jesse's Take ──
    lines.push(`**::Lightbulb:: Jesse's Take**`)
    if (todayRev === 0) {
      lines.push(`  No revenue recorded yet today. Make sure orders are marked PAID or COMPLETED.`)
    } else if (revTrend !== null && revTrend >= 15) {
      lines.push(`  Strong day — up ${revTrend.toFixed(0)}% vs yesterday.${pendingOrders.length > 0 ? ` ${pendingOrders.length} pending order${pendingOrders.length !== 1 ? 's' : ''} still in the queue.` : ' Keep it going.'}`)
    } else if (revTrend !== null && revTrend <= -15) {
      lines.push(`  Revenue is down ${Math.abs(revTrend).toFixed(0)}% vs yesterday.${lowStock.length > 0 ? ` ${lowStock.length} low-stock item${lowStock.length !== 1 ? 's' : ''} may be limiting sales.` : ' Check that orders are being completed.'}`)
    } else if (revTrend !== null) {
      lines.push(`  Tracking close to yesterday (${revTrend >= 0 ? '+' : ''}${revTrend.toFixed(1)}%).${todayOrders.length > 0 ? ` Average order is ${fmt(avgOrder)}.` : ''}`)
    } else {
      lines.push(`  ${todayOrders.length > 0 ? `${todayOrders.length} order${todayOrders.length !== 1 ? 's' : ''} completed today.` : 'No comparable data from yesterday.'}`)
    }

    return NextResponse.json({ answer: lines.join('\n'), period: 'Today', intents, followUps: getFollowUps(intents, allBranches.length), source: 'restaurant-db' })
  }

  // ── CAT 3: WHY — root-cause analysis ─────────────────────────────────────────
  if (intents.includes('why') && !intents.includes('record_transaction')) {
    const subject = question + ' ' + prevQuestion
    const prevIntents = prevQuestion ? parseIntents(prevQuestion) : []
    const whyAbout: Intent[] = prevIntents.length > 0
      ? prevIntents.filter(i => !['greeting', 'catchup', 'why', 'trends'].includes(i)) as Intent[]
      : (parseIntents(subject).filter(i => !['why'].includes(i)) as Intent[])
    const primaryAbout = whyAbout[0] ?? 'revenue'

    const todayStr   = kigaliDateStr()
    const todayStart = kigaliStart(todayStr)
    const range7     = { start: kigaliStart(kigaliDateStr(shiftDays(todayStart, -6))), end: kigaliEnd(todayStr) }
    const range7prev = { start: kigaliStart(kigaliDateStr(shiftDays(todayStart, -13))), end: kigaliEnd(kigaliDateStr(shiftDays(todayStart, -7))) }

    if (primaryAbout === 'revenue' || primaryAbout === 'profit') {
      const [thisWeekSales, lastWeekSales, thisWeekOrders, lastWeekOrders, topDishesThis, topDishesLast, byBranchThis, byBranchLast] = await Promise.all([
        prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: range7.start, lte: range7.end } }, select: { totalSaleAmount: true, calculatedFoodCost: true, paymentMethod: true, dishId: true, dish: { select: { name: true } } } }),
        prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: range7prev.start, lte: range7prev.end } }, select: { totalSaleAmount: true } }),
        prisma.restaurantOrder.count({ where: { restaurantId, createdAt: { gte: range7.start, lte: range7.end } } }),
        prisma.restaurantOrder.count({ where: { restaurantId, createdAt: { gte: range7prev.start, lte: range7prev.end } } }),
        prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: range7.start, lte: range7.end } }, select: { totalSaleAmount: true, dishId: true, dish: { select: { name: true } } } }),
        prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: range7prev.start, lte: range7prev.end } }, select: { totalSaleAmount: true, dishId: true } }),
        allBranches.length > 1 ? prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: range7.start, lte: range7.end } }, select: { totalSaleAmount: true, branchId: true, branch: { select: { name: true } } } }) : Promise.resolve([] as { totalSaleAmount: number | null; branchId: string; branch: { name: string } }[]),
        allBranches.length > 1 ? prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: range7prev.start, lte: range7prev.end } }, select: { totalSaleAmount: true, branchId: true } }) : Promise.resolve([] as { totalSaleAmount: number | null; branchId: string }[]),
      ])

      const thisRev  = thisWeekSales.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
      const lastRev  = lastWeekSales.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
      const thisCogs = thisWeekSales.reduce((s, x) => s + (x.calculatedFoodCost ?? 0), 0)
      const revDelta = lastRev > 0 ? ((thisRev - lastRev) / lastRev) * 100 : null
      const ordDelta = lastWeekOrders > 0 ? ((thisWeekOrders - lastWeekOrders) / lastWeekOrders) * 100 : null

      // Dish-level delta
      const dishThis: Record<string, { name: string; rev: number }> = {}
      const dishLast: Record<string, number> = {}
      for (const s of topDishesThis) { if (!dishThis[s.dishId]) dishThis[s.dishId] = { name: s.dish.name, rev: 0 }; dishThis[s.dishId].rev += s.totalSaleAmount ?? 0 }
      for (const s of topDishesLast) { dishLast[s.dishId] = (dishLast[s.dishId] ?? 0) + (s.totalSaleAmount ?? 0) }
      const dishDrivers = Object.entries(dishThis)
        .map(([id, d]) => ({ name: d.name, thisRev: d.rev, lastRev: dishLast[id] ?? 0, delta: d.rev - (dishLast[id] ?? 0) }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 3)

      // Branch delta
      const bThis: Record<string, { name: string; rev: number }> = {}
      const bLast: Record<string, number> = {}
      for (const s of byBranchThis) { if (!bThis[s.branchId]) bThis[s.branchId] = { name: s.branch.name, rev: 0 }; bThis[s.branchId].rev += s.totalSaleAmount ?? 0 }
      for (const s of byBranchLast) { bLast[s.branchId] = (bLast[s.branchId] ?? 0) + (s.totalSaleAmount ?? 0) }
      const branchDrivers = Object.entries(bThis)
        .map(([id, b]) => ({ name: b.name, thisRev: b.rev, lastRev: bLast[id] ?? 0, delta: b.rev - (bLast[id] ?? 0) }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

      const subject2 = primaryAbout === 'profit' ? 'profit' : 'revenue'
      const overallIcon = revDelta !== null ? (revDelta >= 0 ? '::TrendingUp::' : '::TrendingDown::') : ''

      lines.push(`**Why ${subject2} looks the way it does** — past 7 days`)
      lines.push(``)
      lines.push(`**Overall**`)
      if (revDelta !== null) {
        lines.push(`  ${overallIcon} ${subject2.charAt(0).toUpperCase() + subject2.slice(1)} ${revDelta >= 0 ? 'up' : 'down'} **${dSign(thisRev, lastRev)}**`)
        lines.push(`  This week: **${fmt(thisRev)}** · Last week: ${fmt(lastRev)} · Difference: ${thisRev >= lastRev ? '+' : ''}${fmt(thisRev - lastRev)}`)
      } else {
        lines.push(`  This week: **${fmt(thisRev)}**`)
      }
      lines.push(``)

      // Ranked drivers
      lines.push(`**Main Drivers**`)
      const drivers: string[] = []

      // Order volume
      if (ordDelta !== null) {
        const icon = ordDelta >= 0 ? '::TrendingUp::' : '::TrendingDown::'
        drivers.push(`  ${icon} Orders went from **${lastWeekOrders}** to **${thisWeekOrders}** (${dSign(thisWeekOrders, lastWeekOrders)})`)
      }

      // Dish shifts
      for (const d of dishDrivers) {
        if (Math.abs(d.delta) < 100) continue
        const icon = d.delta >= 0 ? '::TrendingUp::' : '::TrendingDown::'
        drivers.push(`  ${icon} **${d.name}**: ${d.delta >= 0 ? '+' : ''}${fmt(d.delta)} vs last week`)
      }

      // Branch shifts
      for (const b of branchDrivers) {
        if (Math.abs(b.delta) < 100 || allBranches.length < 2) continue
        const icon = b.delta >= 0 ? '::TrendingUp::' : '::TrendingDown::'
        drivers.push(`  ${icon} **${b.name}** station: ${b.delta >= 0 ? '+' : ''}${fmt(b.delta)} vs last week`)
      }

      if (drivers.length === 0 && thisRev === 0) {
        drivers.push(`  ::AlertTriangle:: No revenue this week — orders may not be marked PAID or COMPLETED`)
      } else if (drivers.length === 0) {
        drivers.push(`  Performance is consistent — no single major driver identified`)
      }
      lines.push(...drivers)
      lines.push(``)

      // Biggest factor
      lines.push(`**::Lightbulb:: Biggest Factor**`)
      if (thisRev === 0) {
        lines.push(`  No revenue recorded. Ensure orders are marked PAID or COMPLETED to appear here.`)
      } else if (ordDelta !== null && Math.abs(ordDelta) > 10) {
        const word = ordDelta >= 0 ? 'increase' : 'decrease'
        lines.push(`  The ${word} in order volume (${ordDelta >= 0 ? '+' : ''}${ordDelta.toFixed(0)}%) accounts for most of the ${subject2} shift.`)
      } else if (dishDrivers[0] && Math.abs(dishDrivers[0].delta) > 0) {
        const d = dishDrivers[0]
        lines.push(`  **${d.name}** had the biggest impact — ${d.delta >= 0 ? 'up' : 'down'} ${fmt(Math.abs(d.delta))} vs last week.`)
      } else {
        lines.push(`  Performance is broadly consistent across all categories.`)
      }

      if (primaryAbout === 'profit' && thisCogs > 0) {
        lines.push(`  Food cost this period: **${fmt(thisCogs)}** (${pct(thisCogs, thisRev)} of revenue)`)
      }

    } else if (primaryAbout === 'expenses') {
      const [thisExp, lastExp] = await Promise.all([
        prisma.inventoryPurchase.findMany({ where: { restaurantId, purchasedAt: { gte: range7.start, lte: range7.end } }, select: { totalCost: true, paymentMethod: true, ingredient: { select: { name: true } } }, orderBy: { totalCost: 'desc' } }),
        prisma.inventoryPurchase.aggregate({ where: { restaurantId, purchasedAt: { gte: range7prev.start, lte: range7prev.end } }, _sum: { totalCost: true } }),
      ])
      const thisTotal = thisExp.reduce((s, p) => s + (p.totalCost ?? 0), 0)
      const lastTotal = lastExp._sum.totalCost ?? 0
      lines.push(`**Why expenses look the way they do** — past 7 days`)
      lines.push(``)
      lines.push(`**Overall**`)
      lines.push(`  Total: **${fmt(thisTotal)}** across ${thisExp.length} purchase${thisExp.length !== 1 ? 's' : ''}`)
      if (lastTotal > 0) {
        const icon = thisTotal >= lastTotal ? '::TrendingUp::' : '::TrendingDown::'
        lines.push(`  ${icon} ${dSign(thisTotal, lastTotal)} vs previous 7 days (${fmt(lastTotal)})`)
      }
      if (thisExp.length > 0) {
        lines.push(``)
        lines.push(`**Top Cost Drivers**`)
        thisExp.slice(0, 4).forEach((p, i) => {
          const medal = i === 0 ? '::AlertTriangle::' : '  •'
          lines.push(`  ${medal} **${p.ingredient.name}**: ${fmt(p.totalCost ?? 0)} (${p.paymentMethod ?? 'Cash'})`)
        })
      }
      lines.push(``)
      lines.push(`**::Lightbulb:: Biggest Factor**`)
      if (thisExp.length > 0) {
        const top = thisExp[0]
        lines.push(`  **${top.ingredient.name}** was the highest single expense at ${fmt(top.totalCost ?? 0)}.`)
      } else {
        lines.push(`  No purchases recorded this week.`)
      }

    } else if (primaryAbout === 'orders') {
      const [thisOrders, lastOrders, thisCompleted, thisPending] = await Promise.all([
        prisma.restaurantOrder.count({ where: { restaurantId, createdAt: { gte: range7.start, lte: range7.end } } }),
        prisma.restaurantOrder.count({ where: { restaurantId, createdAt: { gte: range7prev.start, lte: range7prev.end } } }),
        prisma.restaurantOrder.count({ where: { restaurantId, createdAt: { gte: range7.start, lte: range7.end }, status: { in: ['COMPLETED', 'PAID'] } } }),
        prisma.restaurantOrder.count({ where: { restaurantId, createdAt: { gte: range7.start, lte: range7.end }, status: { in: ['PENDING', 'OPEN'] } } }),
      ])
      const completionRate = thisOrders > 0 ? (thisCompleted / thisOrders) * 100 : 0
      lines.push(`**Why order count looks the way it does** — past 7 days`)
      lines.push(``)
      lines.push(`**Overall**`)
      lines.push(`  This week: **${thisOrders} orders** · Last week: ${lastOrders}`)
      if (lastOrders > 0) {
        const icon = thisOrders >= lastOrders ? '::TrendingUp::' : '::TrendingDown::'
        lines.push(`  ${icon} ${dSign(thisOrders, lastOrders)} change in order volume`)
      }
      lines.push(``)
      lines.push(`**Breakdown**`)
      lines.push(`  Completed: **${thisCompleted}** · Pending/open: ${thisPending}`)
      lines.push(`  Completion rate: **${completionRate.toFixed(1)}%**`)
      lines.push(``)
      lines.push(`**::Lightbulb:: Biggest Factor**`)
      if (thisOrders === 0) {
        lines.push(`  No orders placed this week. Check if the waiter app is active and orders are being entered.`)
      } else if (completionRate < 50) {
        lines.push(`  Low completion rate (${completionRate.toFixed(0)}%) — many orders are not being marked PAID or COMPLETED.`)
      } else if (lastOrders > 0 && thisOrders < lastOrders) {
        lines.push(`  Order volume dropped by ${lastOrders - thisOrders} compared to last week. Check if any station was less active.`)
      } else {
        lines.push(`  Order volume is ${thisOrders >= lastOrders ? 'up or stable' : 'lower'} vs last week. Completion rate is ${completionRate.toFixed(0)}%.`)
      }
    } else {
      lines.push(`I need a bit more context. Try:`)
      lines.push(`  • "why is revenue low this week?"`)
      lines.push(`  • "why are expenses high?"`)
      lines.push(`  • "why fewer orders today?"`)
    }

    return NextResponse.json({ answer: lines.join('\n'), period: 'Past 7 days', intents, followUps: getFollowUps(['why'], allBranches.length), source: 'restaurant-db' })
  }

  // ── CAT 5: TRENDS — period-over-period ────────────────────────────────────────
  if (intents.includes('trends') && !intents.includes('record_transaction')) {
    const todayStr      = kigaliDateStr()
    const todayD        = kigaliStart(todayStr)
    const thisWeekStart = kigaliStart(kigaliDateStr(shiftDays(todayD, -6)))
    const lastWeekStart = kigaliStart(kigaliDateStr(shiftDays(todayD, -13)))
    const lastWeekEnd   = kigaliEnd(kigaliDateStr(shiftDays(todayD, -7)))
    const scopeLabel    = targetBranch ? targetBranch.name : 'All Stations'

    const [thisWeekSales, lastWeekSales, thisCompletedOrders, lastCompletedOrders, byBranchThis, byBranchLast, byDishThis, byDishLast] = await Promise.all([
      prisma.dishSale.findMany({ where: { restaurantId, ...branchFilter, saleDate: { gte: thisWeekStart, lte: kigaliEnd(todayStr) } }, select: { totalSaleAmount: true, calculatedFoodCost: true } }),
      prisma.dishSale.findMany({ where: { restaurantId, ...branchFilter, saleDate: { gte: lastWeekStart, lte: lastWeekEnd } }, select: { totalSaleAmount: true, calculatedFoodCost: true } }),
      prisma.restaurantOrder.findMany({ where: { restaurantId, ...branchFilter, createdAt: { gte: thisWeekStart, lte: kigaliEnd(todayStr) }, status: { in: ['COMPLETED', 'PAID'] } }, select: { totalAmount: true } }),
      prisma.restaurantOrder.findMany({ where: { restaurantId, ...branchFilter, createdAt: { gte: lastWeekStart, lte: lastWeekEnd }, status: { in: ['COMPLETED', 'PAID'] } }, select: { totalAmount: true } }),
      allBranches.length > 1 && !branchFilter.branchId
        ? prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: thisWeekStart, lte: kigaliEnd(todayStr) } }, select: { totalSaleAmount: true, branchId: true, branch: { select: { name: true } } } })
        : Promise.resolve([] as { totalSaleAmount: number | null; branchId: string; branch: { name: string } }[]),
      allBranches.length > 1 && !branchFilter.branchId
        ? prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: lastWeekStart, lte: lastWeekEnd } }, select: { totalSaleAmount: true, branchId: true } })
        : Promise.resolve([] as { totalSaleAmount: number | null; branchId: string }[]),
      prisma.dishSale.findMany({ where: { restaurantId, ...branchFilter, saleDate: { gte: thisWeekStart, lte: kigaliEnd(todayStr) } }, select: { totalSaleAmount: true, dishId: true, dish: { select: { name: true } } } }),
      prisma.dishSale.findMany({ where: { restaurantId, ...branchFilter, saleDate: { gte: lastWeekStart, lte: lastWeekEnd } }, select: { totalSaleAmount: true, dishId: true } }),
    ])

    const thisRev    = thisWeekSales.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
    const lastRev    = lastWeekSales.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
    const thisCogs   = thisWeekSales.reduce((s, x) => s + (x.calculatedFoodCost ?? 0), 0)
    const lastCogs   = lastWeekSales.reduce((s, x) => s + (x.calculatedFoodCost ?? 0), 0)
    const thisProfit = thisRev - thisCogs
    const lastProfit = lastRev - lastCogs

    // Volume vs size analysis
    const thisAvgOrder = thisCompletedOrders.length > 0 ? thisCompletedOrders.reduce((s, o) => s + (o.totalAmount ?? 0), 0) / thisCompletedOrders.length : 0
    const lastAvgOrder = lastCompletedOrders.length > 0 ? lastCompletedOrders.reduce((s, o) => s + (o.totalAmount ?? 0), 0) / lastCompletedOrders.length : 0
    const volumeChange = lastCompletedOrders.length > 0 ? ((thisCompletedOrders.length - lastCompletedOrders.length) / lastCompletedOrders.length) * 100 : null
    const sizeChange   = lastAvgOrder > 0 ? ((thisAvgOrder - lastAvgOrder) / lastAvgOrder) * 100 : null

    // Branch delta
    const bThis: Record<string, { name: string; rev: number }> = {}
    const bLast: Record<string, number> = {}
    for (const s of byBranchThis) { if (!bThis[s.branchId]) bThis[s.branchId] = { name: s.branch.name, rev: 0 }; bThis[s.branchId].rev += s.totalSaleAmount ?? 0 }
    for (const s of byBranchLast) { bLast[s.branchId] = (bLast[s.branchId] ?? 0) + (s.totalSaleAmount ?? 0) }
    const branchDeltas = Object.entries(bThis)
      .map(([id, b]) => ({ name: b.name, thisRev: b.rev, lastRev: bLast[id] ?? 0, delta: b.rev - (bLast[id] ?? 0) }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

    // Dish delta
    const dThis: Record<string, { name: string; rev: number }> = {}
    const dLast: Record<string, number> = {}
    for (const s of byDishThis) { if (!dThis[s.dishId]) dThis[s.dishId] = { name: s.dish.name, rev: 0 }; dThis[s.dishId].rev += s.totalSaleAmount ?? 0 }
    for (const s of byDishLast) { dLast[s.dishId] = (dLast[s.dishId] ?? 0) + (s.totalSaleAmount ?? 0) }
    const dishDeltas = Object.entries(dThis)
      .map(([id, d]) => ({ name: d.name, thisRev: d.rev, lastRev: dLast[id] ?? 0, delta: d.rev - (dLast[id] ?? 0) }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 4)

    lines.push(`**Trend — This Week vs Last Week · ${scopeLabel}**`)
    lines.push(``)

    // Revenue
    const revIcon = dIcon(thisRev, lastRev)
    const revWord = lastRev > 0 ? (thisRev >= lastRev * 1.01 ? 'Up' : thisRev <= lastRev * 0.99 ? 'Down' : 'Flat') : '—'
    lines.push(`**::Banknote:: Revenue ${revWord}**`)
    lines.push(`  This week: **${fmt(thisRev)}** · Last week: ${fmt(lastRev)}`)
    if (lastRev > 0) lines.push(`  ${revIcon} ${dSign(thisRev, lastRev)} · Difference: ${thisRev >= lastRev ? '+' : ''}${fmt(thisRev - lastRev)}`)
    lines.push(``)

    // Orders — volume vs size
    lines.push(`**::Users:: Orders — More Customers or Larger Orders?**`)
    lines.push(`  Completed: **${thisCompletedOrders.length}** this week · ${lastCompletedOrders.length} last week`)
    if (volumeChange !== null) {
      const vIcon = dIcon(thisCompletedOrders.length, lastCompletedOrders.length)
      lines.push(`  ${vIcon} Order volume: ${dSign(thisCompletedOrders.length, lastCompletedOrders.length)} (${thisCompletedOrders.length > lastCompletedOrders.length ? 'more' : 'fewer'} customers)`)
    }
    if (sizeChange !== null) {
      const sIcon = dIcon(thisAvgOrder, lastAvgOrder)
      lines.push(`  ${sIcon} Avg order size: ${fmt(thisAvgOrder)} vs ${fmt(lastAvgOrder)} — ${dSign(thisAvgOrder, lastAvgOrder)} (${thisAvgOrder > lastAvgOrder ? 'spending more per order' : 'spending less per order'})`)
    }
    // Determine primary driver
    if (volumeChange !== null && sizeChange !== null && (volumeChange !== 0 || sizeChange !== 0)) {
      const volumeDriven = Math.abs(volumeChange) >= Math.abs(sizeChange)
      lines.push(`  ::ArrowRight:: **Primary driver: ${volumeDriven ? `order volume (${dSign(thisCompletedOrders.length, lastCompletedOrders.length)})` : `order size (${dSign(thisAvgOrder, lastAvgOrder)})`}**`)
    }
    lines.push(``)

    // Food cost
    lines.push(`**::ChefHat:: Food Cost**`)
    lines.push(`  This week: **${fmt(thisCogs)}** (${pct(thisCogs, thisRev)}) · Last week: ${fmt(lastCogs)} (${pct(lastCogs, lastRev)})`)
    if (lastCogs > 0) {
      const cogsIcon = dIcon(thisCogs, lastCogs)
      lines.push(`  ${cogsIcon} ${dSign(thisCogs, lastCogs)} — ${thisCogs > lastCogs ? 'rising faster than revenue is a margin risk' : 'improving relative to revenue'}`)
    }
    lines.push(``)

    // Profit
    const profIcon = dIcon(thisProfit, lastProfit)
    lines.push(`**::Target:: Profit**`)
    lines.push(`  This week: **${fmt(thisProfit)}** (${pct(thisProfit, thisRev)} margin) · Last week: ${fmt(lastProfit)} (${pct(lastProfit, lastRev)})`)
    if (lastProfit > 0) lines.push(`  ${profIcon} ${dSign(thisProfit, lastProfit)} vs last week`)
    lines.push(``)

    // Which branch caused it?
    if (branchDeltas.length > 1) {
      lines.push(`**::BarChart2:: Which Station Caused It?**`)
      branchDeltas.slice(0, 4).forEach(b => {
        const icon = b.delta >= 0 ? '::TrendingUp::' : '::TrendingDown::'
        lines.push(`  ${icon} **${b.name}**: ${b.delta >= 0 ? '+' : ''}${fmt(b.delta)} (this week ${fmt(b.thisRev)} vs last ${fmt(b.lastRev)})`)
      })
      lines.push(``)
    }

    // Which dishes caused it?
    if (dishDeltas.length > 0) {
      lines.push(`**::ChefHat:: Which Dishes Caused It?**`)
      dishDeltas.forEach(d => {
        const icon = d.delta >= 0 ? '::TrendingUp::' : '::TrendingDown::'
        lines.push(`  ${icon} **${d.name}**: ${d.delta >= 0 ? '+' : ''}${fmt(d.delta)} (this week ${fmt(d.thisRev)} vs last ${fmt(d.lastRev)})`)
      })
      lines.push(``)
    }

    // Jesse's Take
    lines.push(`**::Lightbulb:: Jesse's Take**`)
    if (thisRev === 0 && lastRev === 0) {
      lines.push(`  No sales data for either period.`)
    } else if (thisRev > lastRev && thisCogs / thisRev > lastCogs / (lastRev || 1) + 0.05) {
      lines.push(`  Revenue grew but food costs rose faster — margins are squeezed. Worth reviewing purchasing.`)
    } else if (thisRev >= lastRev) {
      const driver = volumeChange !== null && sizeChange !== null
        ? (Math.abs(volumeChange) >= Math.abs(sizeChange) ? `driven by ${thisCompletedOrders.length > lastCompletedOrders.length ? 'more orders' : 'fewer orders'}` : `driven by ${thisAvgOrder > lastAvgOrder ? 'higher spend per order' : 'lower spend per order'}`)
        : ''
      lines.push(`  Business is ${thisRev > lastRev * 1.1 ? 'growing well' : 'holding steady'}${driver ? ` — ${driver}` : ''}.`)
    } else {
      const topLoser = dishDeltas[0]?.delta < 0 ? dishDeltas[0] : null
      const topBranchLoser = branchDeltas[0]?.delta < 0 ? branchDeltas[0] : null
      let take = `Revenue is down vs last week.`
      if (topBranchLoser) take += ` **${topBranchLoser.name}** contributed the most to the drop (${fmt(topBranchLoser.delta)}).`
      else if (topLoser) take += ` **${topLoser.name}** had the biggest drop (${fmt(topLoser.delta)}).`
      if (volumeChange !== null && volumeChange < -10) take += ` Order volume fell ${Math.abs(volumeChange).toFixed(0)}%.`
      lines.push(`  ${take}`)
    }

    return NextResponse.json({ answer: lines.join('\n'), period: 'This week vs last', intents, followUps: getFollowUps(['trends'], allBranches.length), source: 'restaurant-db' })
  }

  // ── Follow-up / clarification (no prior context available) ───────────────────
  if (/\b(what\s+happened|why\s+(did|was|is|are)\b|what\s+does\s+that\s+mean|tell\s+me\s+more|explain\s+that|what\s+went\s+wrong|why\s+zero|why\s+0)\b/i.test(question) && intents.length === 1 && intents[0] === 'revenue') {
    lines.push(`::AlertTriangle:: I don't have context from your previous message.`)
    lines.push(`  Each question I answer is independent — I don't remember what came before.`)
    lines.push(`  Try asking the full question again, for example:`)
    lines.push(`  • "why is today's revenue 0?"`)
    lines.push(`  • "what happened to yesterday's sales?"`)
    lines.push(`  • "explain this week's expenses"`)
    return NextResponse.json({ answer: lines.join('\n'), period: range.label, intents, followUps: getFollowUps(intents, allBranches.length), source: 'restaurant-db' })
  }

  // ── Revenue / Profit / Food Cost / Payment ───────────────────────────────────
  if (intents.some(i => ['revenue', 'profit', 'payment', 'food_cost'].includes(i)) && !intents.includes('branch_comparison') && !intents.includes('record_transaction')) {
    const prevRange = getPreviousRange(range)

    const [sales, prevSales, topDishes, branchSales] = await Promise.all([
      prisma.dishSale.findMany({
        where: { restaurantId, ...branchFilter, saleDate: { gte: range.start, lte: range.end } },
        select: { totalSaleAmount: true, calculatedFoodCost: true, paymentMethod: true, dishId: true, dish: { select: { name: true } }, branchId: true, branch: { select: { name: true } } },
      }),
      prevRange ? prisma.dishSale.aggregate({
        where: { restaurantId, ...branchFilter, saleDate: { gte: prevRange.start, lte: prevRange.end } },
        _sum: { totalSaleAmount: true, calculatedFoodCost: true },
      }) : Promise.resolve(null),
      prisma.dishSale.groupBy({
        by: ['dishId'],
        where: { restaurantId, ...branchFilter, saleDate: { gte: range.start, lte: range.end } },
        _sum: { totalSaleAmount: true, quantitySold: true },
        orderBy: { _sum: { totalSaleAmount: 'desc' } },
        take: 5,
      }),
      allBranches.length > 1 && !branchFilter.branchId
        ? prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: range.start, lte: range.end } }, select: { totalSaleAmount: true, branchId: true, branch: { select: { name: true } } } })
        : Promise.resolve([] as { totalSaleAmount: number | null; branchId: string; branch: { name: string } }[]),
    ])

    const totalRev  = sales.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
    const totalCogs = sales.reduce((s, x) => s + (x.calculatedFoodCost ?? 0), 0)
    const prevRev   = prevSales?._sum.totalSaleAmount ?? 0
    const prevCogs  = prevSales?._sum.calculatedFoodCost ?? 0

    // Payment method breakdown
    const pmBreakdown: Record<string, { amount: number; count: number }> = {}
    for (const s of sales) {
      const m = s.paymentMethod ?? 'Cash'
      if (!pmBreakdown[m]) pmBreakdown[m] = { amount: 0, count: 0 }
      pmBreakdown[m].amount += s.totalSaleAmount ?? 0
      pmBreakdown[m].count++
    }
    const pmRanked = Object.entries(pmBreakdown).sort((a, b) => b[1].amount - a[1].amount)

    // Dish names for topDishes
    const dishNameMap: Record<string, string> = {}
    for (const s of sales) dishNameMap[s.dishId] = s.dish.name

    // Branch breakdown
    const bMap: Record<string, { name: string; rev: number }> = {}
    for (const s of branchSales) {
      if (!bMap[s.branchId]) bMap[s.branchId] = { name: s.branch.name, rev: 0 }
      bMap[s.branchId].rev += s.totalSaleAmount ?? 0
    }
    const bRanked = Object.values(bMap).sort((a, b) => b.rev - a.rev)

    if (intents.includes('payment')) {
      if (pmFilter) {
        const filtered = sales.filter(s => s.paymentMethod === pmFilter)
        const amount   = filtered.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
        lines.push(`**${pmFilter} Revenue** — ${range.label} · ${branchLabel}`)
        lines.push(`  Amount: **${fmt(amount)}** (${pct(amount, totalRev)} of total revenue)`)
        lines.push(`  Transactions: ${filtered.length}`)
        if (prevRange && prevRev > 0) {
          lines.push(`  ${range.label}: ${fmt(amount)} · Compare with full payment breakdown for ${prevRange.label}`)
        }
      } else {
        lines.push(`**Payment Method Breakdown** — ${range.label} · ${branchLabel}`)
        lines.push(`  Total: **${fmt(totalRev)}**`)
        lines.push(``)
        pmRanked.forEach(([method, d], i) => {
          const medal = i === 0 ? '::Star::' : i === 1 ? '::Award::' : '  '
          lines.push(`  ${medal} **${method}**: ${fmt(d.amount)} (${pct(d.amount, totalRev)}) · ${d.count} transactions`)
        })
        if (pmRanked.length > 0) {
          lines.push(``)
          lines.push(`**::Lightbulb:: Insight**`)
          lines.push(`  **${pmRanked[0][0]}** is the dominant payment method at ${pct(pmRanked[0][1].amount, totalRev)} of revenue.`)
        }
      }
    }

    if (intents.includes('revenue') && !intents.includes('payment')) {
      lines.push(`**Revenue** — ${range.label} · ${branchLabel}`)
      lines.push(`  Total: **${fmt(totalRev)}**`)

      if (totalRev === 0) {
        lines.push(`  ::AlertTriangle:: No completed orders found for this period.`)
        lines.push(`  Revenue records when orders are marked PAID or COMPLETED.`)
      } else {
        lines.push(`  Transactions: ${sales.length}${sales.length > 0 ? ` · Avg per sale: ${fmt(totalRev / sales.length)}` : ''}`)

        // Comparison
        if (prevRange && prevRev > 0) {
          const icon = dIcon(totalRev, prevRev)
          lines.push(``)
          lines.push(`**vs ${prevRange.label}**`)
          lines.push(`  ${icon} ${dSign(totalRev, prevRev)} · ${prevRange.label}: ${fmt(prevRev)} · Difference: ${totalRev >= prevRev ? '+' : ''}${fmt(totalRev - prevRev)}`)
        }

        // Payment breakdown
        if (pmRanked.length > 1) {
          lines.push(``)
          lines.push(`**Payment Breakdown**`)
          pmRanked.forEach(([m, d]) => lines.push(`  ${m}: **${fmt(d.amount)}** (${pct(d.amount, totalRev)})`))
        }

        // Branch breakdown
        if (bRanked.length > 1) {
          lines.push(``)
          lines.push(`**By Station**`)
          bRanked.forEach((b, i) => {
            const medal = i === 0 ? '::Star::' : i === 1 ? '::Award::' : '  '
            lines.push(`  ${medal} **${b.name}**: ${fmt(b.rev)} (${pct(b.rev, totalRev)})`)
          })
        }

        // Top dishes
        if (topDishes.length > 0) {
          lines.push(``)
          lines.push(`**Top Sellers**`)
          topDishes.slice(0, 3).forEach((d, i) => {
            const name = dishNameMap[d.dishId] ?? d.dishId
            const rev  = d._sum.totalSaleAmount ?? 0
            const medal = i === 0 ? '::Flame::' : i === 1 ? '::Award::' : '  '
            lines.push(`  ${medal} ${i + 1}. **${name}**: ${fmt(rev)} (${pct(rev, totalRev)})`)
          })
        }

        // Insights
        const insights: string[] = []
        if (bRanked.length > 1 && bRanked[0]) {
          const share = (bRanked[0].rev / totalRev) * 100
          if (share > 60) insights.push(`**${bRanked[0].name}** generated ${share.toFixed(0)}% of total revenue — highly concentrated.`)
        }
        if (topDishes[0]) {
          const topRev = topDishes[0]._sum.totalSaleAmount ?? 0
          const topShare = totalRev > 0 ? (topRev / totalRev) * 100 : 0
          if (topShare > 30) insights.push(`**${dishNameMap[topDishes[0].dishId] ?? '—'}** accounts for ${topShare.toFixed(0)}% of all revenue — your biggest driver.`)
        }
        if (pmRanked[0] && (pmRanked[0][1].amount / totalRev) > 0.7) {
          insights.push(`${pct(pmRanked[0][1].amount, totalRev)} of payments come through **${pmRanked[0][0]}**.`)
        }
        if (prevRange && prevRev > 0) {
          const delta = ((totalRev - prevRev) / prevRev) * 100
          if (Math.abs(delta) > 20) insights.push(`Revenue ${delta > 0 ? 'grew' : 'dropped'} ${Math.abs(delta).toFixed(0)}% vs ${prevRange.label} — a significant shift.`)
        }
        if (insights.length > 0) {
          lines.push(``)
          lines.push(`**::Lightbulb:: Key Insights**`)
          insights.forEach(ins => lines.push(`  • ${ins}`))
        }
      }
    }

    if (intents.includes('food_cost')) {
      lines.push(`**Food Cost** — ${range.label} · ${branchLabel}`)
      lines.push(`  COGS: **${fmt(totalCogs)}**`)
      lines.push(`  Food Cost %: **${pct(totalCogs, totalRev)}**`)
      if (prevCogs > 0) {
        const icon = dIcon(totalCogs, prevCogs)
        lines.push(`  ${icon} ${dSign(totalCogs, prevCogs)} vs ${prevRange?.label} (${fmt(prevCogs)}, ${pct(prevCogs, prevRev)})`)
      }
      lines.push(``)
      lines.push(`**::Lightbulb:: Insight**`)
      const fc = totalRev > 0 ? (totalCogs / totalRev) * 100 : 0
      if (fc < 25) lines.push(`  Food cost at ${fc.toFixed(1)}% — well controlled. Industry benchmark is 28–35%.`)
      else if (fc < 35) lines.push(`  Food cost at ${fc.toFixed(1)}% — within normal range. Benchmark is 28–35%.`)
      else lines.push(`  Food cost at ${fc.toFixed(1)}% — above typical range of 28–35%. Review high-cost ingredients.`)
    }

    if (intents.includes('profit')) {
      const [wasteLogs, prevWaste] = await Promise.all([
        prisma.wasteLog.findMany({ where: { restaurantId, ...branchFilter, date: { gte: range.start, lte: range.end } }, select: { calculatedCost: true } }),
        prevRange ? prisma.wasteLog.aggregate({ where: { restaurantId, ...branchFilter, date: { gte: prevRange.start, lte: prevRange.end } }, _sum: { calculatedCost: true } }) : Promise.resolve(null),
      ])
      const wasteCost  = wasteLogs.reduce((s, x) => s + (x.calculatedCost ?? 0), 0)
      const profit     = totalRev - totalCogs - wasteCost
      const prevProfit = prevRev - prevCogs - (prevWaste?._sum.calculatedCost ?? 0)

      lines.push(`**Profit & Loss** — ${range.label} · ${branchLabel}`)
      lines.push(``)
      lines.push(`  ::Banknote:: Revenue:   **${fmt(totalRev)}**`)
      lines.push(`  ::ChefHat:: Food Cost:  ${fmt(totalCogs)} (${pct(totalCogs, totalRev)})`)
      if (wasteCost > 0) lines.push(`  ::AlertTriangle:: Waste: ${fmt(wasteCost)} (${pct(wasteCost, totalRev)})`)
      lines.push(`  ─`)
      const profIcon = profit >= 0 ? '::TrendingUp::' : '::TrendingDown::'
      lines.push(`  ${profIcon} **${profit >= 0 ? 'Profit' : 'Loss'}: ${fmt(Math.abs(profit))} (${pct(Math.abs(profit), totalRev)} margin)**`)

      if (prevRange && prevRev > 0) {
        lines.push(``)
        lines.push(`**vs ${prevRange.label}**`)
        const icon = dIcon(profit, prevProfit)
        lines.push(`  ${icon} Profit: ${dSign(profit, prevProfit)} · ${prevRange.label}: ${fmt(prevProfit)}`)
        lines.push(`  Revenue: ${dSign(totalRev, prevRev)} · Food cost: ${dSign(totalCogs, prevCogs)}`)
      }

      lines.push(``)
      lines.push(`**::Lightbulb:: Jesse's Take**`)
      const margin = totalRev > 0 ? (profit / totalRev) * 100 : 0
      if (totalRev === 0) {
        lines.push(`  No revenue recorded. Profit cannot be calculated without sales.`)
      } else if (margin >= 20) {
        lines.push(`  Healthy margins at ${margin.toFixed(1)}%. Food cost is well controlled${wasteCost > 0 ? `, though waste (${fmt(wasteCost)}) is eating into profit` : ''}.`)
      } else if (margin >= 10) {
        lines.push(`  Margins are moderate at ${margin.toFixed(1)}%. ${totalCogs / totalRev > 0.35 ? 'Food costs are above average — review purchasing.' : 'Look for opportunities to increase order volume.'}`)
      } else if (margin >= 0) {
        lines.push(`  Margins are thin at ${margin.toFixed(1)}%. Food cost (${pct(totalCogs, totalRev)}) is the main factor${wasteCost > 0 ? `, plus ${fmt(wasteCost)} in waste` : ''}.`)
      } else {
        lines.push(`  Operating at a loss. Revenue (${fmt(totalRev)}) is not covering food cost (${fmt(totalCogs)})${wasteCost > 0 ? ` plus waste (${fmt(wasteCost)})` : ''}. Review pricing or costs.`)
      }
    }
  }

  // ── Orders ───────────────────────────────────────────────────────────────────
  if (intents.includes('orders') && !intents.includes('pending_orders')) {
    const prevRange = getPreviousRange(range)
    const [orders, prevCount] = await Promise.all([
      prisma.restaurantOrder.findMany({
        where: { restaurantId, ...branchFilter, createdAt: { gte: range.start, lte: range.end } },
        select: { status: true, totalAmount: true, branch: { select: { name: true } }, branchId: true },
      }),
      prevRange ? prisma.restaurantOrder.count({ where: { restaurantId, ...branchFilter, createdAt: { gte: prevRange.start, lte: prevRange.end } } }) : Promise.resolve(0),
    ])

    const completed    = orders.filter(o => ['COMPLETED', 'PAID'].includes(o.status ?? ''))
    const pending      = orders.filter(o => ['PENDING', 'OPEN'].includes(o.status ?? ''))
    const totalAmt     = orders.reduce((s, o) => s + (o.totalAmount ?? 0), 0)
    const completedAmt = completed.reduce((s, o) => s + (o.totalAmount ?? 0), 0)
    const avgOrder     = completed.length > 0 ? completedAmt / completed.length : 0
    const completionPct = orders.length > 0 ? (completed.length / orders.length) * 100 : 0

    lines.push(`**Orders** — ${range.label} · ${branchLabel}`)
    lines.push(`  Total: **${orders.length}**`)
    lines.push(``)
    lines.push(`**Breakdown**`)
    lines.push(`  ::CheckCircle:: Completed: **${completed.length}** (${completionPct.toFixed(0)}% completion rate)`)
    lines.push(`  ::Clock:: Pending / open: ${pending.length}`)
    lines.push(`  Order value: ${fmt(totalAmt)} · Avg completed order: **${fmt(avgOrder)}**`)

    if (prevRange && prevCount > 0) {
      lines.push(``)
      lines.push(`**vs ${prevRange.label}**`)
      const icon = dIcon(orders.length, prevCount)
      lines.push(`  ${icon} ${dSign(orders.length, prevCount)} · ${prevRange.label}: ${prevCount} orders · This period: ${orders.length}`)
    }

    // Branch breakdown
    if (allBranches.length > 1) {
      const bMap: Record<string, number> = {}
      for (const o of orders) { const b = o.branch?.name ?? 'Unknown'; bMap[b] = (bMap[b] ?? 0) + 1 }
      const bRanked = Object.entries(bMap).sort((a, b) => b[1] - a[1])
      if (bRanked.length > 1) {
        lines.push(``)
        lines.push(`**By Station**`)
        bRanked.forEach(([b, c], i) => {
          const medal = i === 0 ? '::Star::' : '  '
          lines.push(`  ${medal} **${b}**: ${c} orders (${pct(c, orders.length)})`)
        })
      }
    }

    lines.push(``)
    lines.push(`**::Lightbulb:: Jesse's Take**`)
    if (orders.length === 0) {
      lines.push(`  No orders recorded for this period. Check if the waiter app is being used.`)
    } else if (completionPct < 50) {
      lines.push(`  Completion rate is low at ${completionPct.toFixed(0)}% — ${pending.length} order${pending.length !== 1 ? 's' : ''} still pending. Make sure orders are being marked PAID or COMPLETED.`)
    } else if (prevCount > 0 && orders.length > prevCount) {
      lines.push(`  Order volume is up ${orders.length - prevCount} orders vs ${prevRange?.label}. Average order value is ${fmt(avgOrder)}.`)
    } else {
      lines.push(`  ${completed.length} out of ${orders.length} orders completed (${completionPct.toFixed(0)}%). Average completed order: ${fmt(avgOrder)}.`)
    }
  }

  // ── Pending Orders (right now, no date filter) ────────────────────────────────
  if (intents.includes('pending_orders')) {
    const pending = await prisma.restaurantOrder.findMany({
      where: { restaurantId, ...branchFilter, status: { in: ['PENDING', 'OPEN'] } },
      select: { status: true, totalAmount: true, table: { select: { name: true } }, branch: { select: { name: true } }, branchId: true },
    })
    const totalAmt = pending.reduce((s, o) => s + (o.totalAmount ?? 0), 0)
    const avgAmt   = pending.length > 0 ? totalAmt / pending.length : 0

    lines.push(`**Pending Orders Right Now** — ${branchLabel}`)
    if (pending.length === 0) {
      lines.push(`  ::CheckCircle:: No pending orders — all clear.`)
    } else {
      lines.push(`  Count: **${pending.length} order${pending.length !== 1 ? 's' : ''}**`)
      lines.push(`  Total value in queue: **${fmt(totalAmt)}**`)
      lines.push(`  Average order: ${fmt(avgAmt)}`)

      if (allBranches.length > 1) {
        const byBranch: Record<string, { count: number; value: number }> = {}
        for (const o of pending) {
          const b = o.branch?.name ?? 'Unknown'
          if (!byBranch[b]) byBranch[b] = { count: 0, value: 0 }
          byBranch[b].count++
          byBranch[b].value += o.totalAmount ?? 0
        }
        const bRanked = Object.entries(byBranch).sort((a, b) => b[1].count - a[1].count)
        if (bRanked.length > 1) {
          lines.push(``)
          lines.push(`**By Station**`)
          bRanked.forEach(([b, d]) => lines.push(`  ::Clock:: **${b}**: ${d.count} order${d.count !== 1 ? 's' : ''} · ${fmt(d.value)}`))
        }
      }

      lines.push(``)
      lines.push(`**::Lightbulb:: Jesse's Take**`)
      if (pending.length >= 10) {
        lines.push(`  ${pending.length} orders pending — high queue. Make sure waiters are processing and completing orders promptly.`)
      } else {
        lines.push(`  ${pending.length} order${pending.length !== 1 ? 's' : ''} in queue worth ${fmt(totalAmt)}. Complete them to record revenue.`)
      }
    }
  }

  // ── Average Order Value ───────────────────────────────────────────────────────
  if (intents.includes('avg_order')) {
    const prevRange = getPreviousRange(range)
    const [orders, prevOrders] = await Promise.all([
      prisma.restaurantOrder.findMany({
        where: { restaurantId, ...branchFilter, createdAt: { gte: range.start, lte: range.end }, status: { in: ['COMPLETED', 'PAID'] } },
        select: { totalAmount: true, branchId: true, branch: { select: { name: true } } },
      }),
      prevRange ? prisma.restaurantOrder.findMany({
        where: { restaurantId, ...branchFilter, createdAt: { gte: prevRange.start, lte: prevRange.end }, status: { in: ['COMPLETED', 'PAID'] } },
        select: { totalAmount: true },
      }) : Promise.resolve([]),
    ])

    const totalAmt  = orders.reduce((s, o) => s + (o.totalAmount ?? 0), 0)
    const avg       = orders.length > 0 ? totalAmt / orders.length : 0
    const prevAmt   = prevOrders.reduce((s, o) => s + (o.totalAmount ?? 0), 0)
    const prevAvg   = prevOrders.length > 0 ? prevAmt / prevOrders.length : 0

    lines.push(`**Average Order Value** — ${range.label} · ${branchLabel}`)
    lines.push(`  Average: **${fmt(avg)}**`)
    lines.push(`  Based on ${orders.length} completed order${orders.length !== 1 ? 's' : ''} · Total: ${fmt(totalAmt)}`)

    if (prevRange && prevAvg > 0) {
      const icon = dIcon(avg, prevAvg)
      lines.push(``)
      lines.push(`**vs ${prevRange.label}**`)
      lines.push(`  ${icon} ${dSign(avg, prevAvg)} · ${prevRange.label}: ${fmt(prevAvg)} (${prevOrders.length} orders)`)
    }

    // By branch if multi-branch
    if (allBranches.length > 1) {
      const bMap: Record<string, { name: string; total: number; count: number }> = {}
      for (const o of orders) {
        if (!bMap[o.branchId]) bMap[o.branchId] = { name: o.branch?.name ?? 'Unknown', total: 0, count: 0 }
        bMap[o.branchId].total += o.totalAmount ?? 0
        bMap[o.branchId].count++
      }
      const bRanked = Object.values(bMap).map(b => ({ ...b, avg: b.count > 0 ? b.total / b.count : 0 })).sort((a, b) => b.avg - a.avg)
      if (bRanked.length > 1) {
        lines.push(``)
        lines.push(`**By Station**`)
        bRanked.forEach((b, i) => {
          const medal = i === 0 ? '::Star::' : '  '
          lines.push(`  ${medal} **${b.name}**: ${fmt(b.avg)} avg (${b.count} orders)`)
        })
      }
    }

    lines.push(``)
    lines.push(`**::Lightbulb:: Jesse's Take**`)
    if (orders.length === 0) {
      lines.push(`  No completed orders for this period.`)
    } else if (prevAvg > 0) {
      const delta = ((avg - prevAvg) / prevAvg) * 100
      if (delta > 10) lines.push(`  Average order value is up ${delta.toFixed(1)}% vs ${prevRange?.label}. Customers are spending more per visit.`)
      else if (delta < -10) lines.push(`  Average order value dropped ${Math.abs(delta).toFixed(1)}% vs ${prevRange?.label}. Check if menu prices changed or order composition shifted.`)
      else lines.push(`  Average order value is stable at ${fmt(avg)} — consistent with ${prevRange?.label}.`)
    } else {
      lines.push(`  Average completed order is ${fmt(avg)} across ${orders.length} order${orders.length !== 1 ? 's' : ''}.`)
    }
  }

  // ── Expenses ─────────────────────────────────────────────────────────────────
  if (intents.includes('expenses') && !intents.includes('branch_comparison') && !intents.includes('record_transaction')) {
    const prevRange = getPreviousRange(range)
    const [purchases, prevTotal] = await Promise.all([
      prisma.inventoryPurchase.findMany({
        where: { restaurantId, ...branchFilter, purchasedAt: { gte: range.start, lte: range.end } },
        select: { totalCost: true, paymentMethod: true, ingredient: { select: { name: true } }, branchId: true, branch: { select: { name: true } } },
        orderBy: { totalCost: 'desc' },
      }),
      prevRange ? prisma.inventoryPurchase.aggregate({ where: { restaurantId, ...branchFilter, purchasedAt: { gte: prevRange.start, lte: prevRange.end } }, _sum: { totalCost: true } }) : Promise.resolve(null),
    ])

    const total    = purchases.reduce((s, p) => s + (p.totalCost ?? 0), 0)
    const prevAmt  = prevTotal?._sum.totalCost ?? 0

    // Build ingredient name map
    const ingMap: Record<string, string> = {}
    for (const p of purchases) ingMap[p.ingredient.name] = p.ingredient.name

    // Payment breakdown
    const pmBreak: Record<string, number> = {}
    for (const p of purchases) { const m = p.paymentMethod ?? 'Cash'; pmBreak[m] = (pmBreak[m] ?? 0) + (p.totalCost ?? 0) }
    const pmRanked = Object.entries(pmBreak).sort((a, b) => b[1] - a[1])

    lines.push(`**Expenses** — ${range.label} · ${branchLabel}`)
    lines.push(`  Total: **${fmt(total)}**`)
    lines.push(`  ${purchases.length} purchase transaction${purchases.length !== 1 ? 's' : ''}`)

    if (prevRange && prevAmt > 0) {
      const icon = dIcon(total, prevAmt)
      lines.push(`  ${icon} ${dSign(total, prevAmt)} vs ${prevRange.label} (${fmt(prevAmt)})`)
    }

    // Top cost items
    if (purchases.length > 0) {
      lines.push(``)
      lines.push(`**Top Costs**`)
      const seen = new Set<string>()
      let rank = 0
      for (const p of purchases) {
        if (seen.has(p.ingredient.name)) continue
        seen.add(p.ingredient.name)
        const medal = rank === 0 ? '::AlertTriangle::' : rank === 1 ? '::Award::' : '  '
        lines.push(`  ${medal} ${rank + 1}. **${p.ingredient.name}**: ${fmt(p.totalCost ?? 0)} (${pct(p.totalCost ?? 0, total)})`)
        rank++
        if (rank >= 5) break
      }
    }

    // Payment breakdown
    if (pmRanked.length > 1) {
      lines.push(``)
      lines.push(`**Payment Methods**`)
      pmRanked.forEach(([m, amt]) => lines.push(`  ${m}: **${fmt(amt)}** (${pct(amt, total)})`))
    }

    // Branch breakdown
    if (allBranches.length > 1) {
      const bMap: Record<string, { name: string; total: number }> = {}
      for (const p of purchases) {
        if (!bMap[p.branchId]) bMap[p.branchId] = { name: p.branch?.name ?? 'Unknown', total: 0 }
        bMap[p.branchId].total += p.totalCost ?? 0
      }
      const bRanked = Object.values(bMap).sort((a, b) => b.total - a.total)
      if (bRanked.length > 1) {
        lines.push(``)
        lines.push(`**By Station**`)
        bRanked.forEach((b, i) => {
          const medal = i === 0 ? '::Star::' : '  '
          lines.push(`  ${medal} **${b.name}**: ${fmt(b.total)} (${pct(b.total, total)})`)
        })
      }
    }

    lines.push(``)
    lines.push(`**::Lightbulb:: Jesse's Take**`)
    if (total === 0) {
      lines.push(`  No purchase expenses recorded for this period.`)
    } else if (prevAmt > 0) {
      const delta = ((total - prevAmt) / prevAmt) * 100
      if (delta > 20) lines.push(`  Expenses jumped ${delta.toFixed(0)}% vs ${prevRange?.label}. Review the top cost items to confirm they're necessary.`)
      else if (delta < -20) lines.push(`  Expenses dropped ${Math.abs(delta).toFixed(0)}% vs ${prevRange?.label} — good cost control, or lower purchasing activity.`)
      else lines.push(`  Expenses are in line with ${prevRange?.label} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%).`)
    } else {
      const topItem = purchases[0]
      if (topItem) lines.push(`  **${topItem.ingredient.name}** was the biggest expense at ${fmt(topItem.totalCost ?? 0)} (${pct(topItem.totalCost ?? 0, total)} of total).`)
    }
  }

  // ── Waste ─────────────────────────────────────────────────────────────────────
  if (intents.includes('waste')) {
    const wasteLogs = await prisma.wasteLog.findMany({
      where: { restaurantId, date: { gte: range.start, lte: range.end } },
      select: { calculatedCost: true },
    })
    const total = wasteLogs.reduce((s, w) => s + (w.calculatedCost ?? 0), 0)
    lines.push(`**Waste** — ${range.label} · All Stations`)
    lines.push(`  Total Loss: **${fmt(total)}**`)
    lines.push(`  Incidents: ${wasteLogs.length}`)
  }

  // ── Top Dishes — defaults to This Month when no time period given ─────────────
  if (intents.includes('top_dishes')) {
    const dishRange = hasExplicitTimePeriod(question) ? range : thisMonthRange()
    const sales = await prisma.dishSale.findMany({
      where: { restaurantId, ...branchFilter, saleDate: { gte: dishRange.start, lte: dishRange.end } },
      select: { totalSaleAmount: true, quantitySold: true, dishId: true, dish: { select: { name: true } }, branchId: true, branch: { select: { name: true } } },
    })

    const map: Record<string, { name: string; revenue: number; qty: number }> = {}
    for (const s of sales) {
      if (!map[s.dishId]) map[s.dishId] = { name: s.dish.name, revenue: 0, qty: 0 }
      map[s.dishId].revenue += s.totalSaleAmount ?? 0
      map[s.dishId].qty     += s.quantitySold ?? 0
    }
    const totalRev = sales.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
    const top      = Object.values(map).sort((a, b) => b.revenue - a.revenue).slice(0, 8)

    lines.push(`**Top Dishes / Best Sellers** — ${dishRange.label} · ${branchLabel}`)

    if (top.length === 0) {
      lines.push(`  No sales data for this period.`)
    } else {
      lines.push(``)
      lines.push(`**Rankings**`)
      const medals = ['::Flame::', '::Star::', '::Award::', '  ', '  ', '  ', '  ', '  ']
      top.forEach((d, i) => {
        const share = totalRev > 0 ? ` · ${pct(d.revenue, totalRev)} of revenue` : ''
        lines.push(`  ${medals[i]} **${i + 1}. ${d.name}** — ${fmt(d.revenue)} (${d.qty} sold${share})`)
      })

      // Insights
      const topDish = top[0]
      const insights: string[] = []
      if (totalRev > 0 && topDish.revenue / totalRev > 0.3) {
        insights.push(`**${topDish.name}** drives ${pct(topDish.revenue, totalRev)} of all dish revenue — your single biggest earner.`)
      }
      if (top.length >= 3) {
        const top3Rev = top.slice(0, 3).reduce((s, d) => s + d.revenue, 0)
        if (totalRev > 0 && top3Rev / totalRev > 0.6) {
          insights.push(`Top 3 dishes account for ${pct(top3Rev, totalRev)} of revenue — consider protecting their stock levels.`)
        }
      }

      if (insights.length > 0) {
        lines.push(``)
        lines.push(`**::Lightbulb:: Key Insights**`)
        insights.forEach(ins => lines.push(`  • ${ins}`))
      }

      lines.push(``)
      lines.push(`**::Lightbulb:: Jesse's Take**`)
      if (top.length === 1) {
        lines.push(`  Only one dish generating revenue this period. Check if other dishes are available and being ordered.`)
      } else {
        lines.push(`  **${topDish.name}** leads with ${fmt(topDish.revenue)} (${topDish.qty} sold). Make sure it stays in stock.`)
      }
    }
  }

  // ── Specific Dish Query ───────────────────────────────────────────────────────
  if (intents.includes('dish_query')) {
    const dishName = parseDishName(question)
    if (dishName) {
      // Match dish names case-insensitively in JS rather than via Prisma's
      // `mode: 'insensitive'` — that filter option only exists on Postgres,
      // and this route also compiles against the SQLite schema for local-first
      // desktop builds, where the generated StringFilter type doesn't have it.
      const dishNameLower = dishName.toLowerCase()
      const candidateDishes = await prisma.dish.findMany({
        where: { restaurantId },
        select: { id: true, name: true },
      })
      const matchingDishIds = candidateDishes
        .filter(d => d.name.toLowerCase().includes(dishNameLower))
        .map(d => d.id)

      const sales = matchingDishIds.length === 0 ? [] : await prisma.dishSale.findMany({
        where: {
          restaurantId,
          saleDate: { gte: range.start, lte: range.end },
          dishId: { in: matchingDishIds },
        },
        include: { dish: { select: { name: true } } },
      })
      if (sales.length === 0) {
        lines.push(`**"${dishName}"** — ${range.label}`)
        lines.push(`  No sales found. Check the dish name or try a different period.`)
      } else {
        // Group by dish name (multiple dishes might match)
        const map: Record<string, { name: string; revenue: number; qty: number }> = {}
        for (const s of sales) {
          const key = s.dish.name
          if (!map[key]) map[key] = { name: key, revenue: 0, qty: 0 }
          map[key].revenue += s.totalSaleAmount ?? 0
          map[key].qty     += s.quantitySold ?? 0
        }
        const results = Object.values(map).sort((a, b) => b.revenue - a.revenue)
        lines.push(`**"${dishName}" Sales** — ${range.label} · All Stations`)
        results.forEach(d => {
          lines.push(`  ${d.name}`)
          lines.push(`    Revenue: **${fmt(d.revenue)}**`)
          lines.push(`    Qty sold: ${d.qty}`)
        })
      }
    } else {
      lines.push(`Try asking: "how much did we make from burgers this week?" or "how many chicken wings did we sell today?"`)
    }
  }

  // ── Branch Comparison ─────────────────────────────────────────────────────────
  if (intents.includes('branch_comparison')) {
    if (intents.includes('expenses')) {
      const purchases = await prisma.inventoryPurchase.findMany({
        where: { restaurantId, purchasedAt: { gte: range.start, lte: range.end } },
        select: { totalCost: true, branchId: true, branch: { select: { name: true } } },
      })
      const byBranch: Record<string, { name: string; total: number; count: number }> = {}
      for (const p of purchases) {
        const id = p.branchId
        if (!byBranch[id]) byBranch[id] = { name: p.branch?.name ?? 'Unknown', total: 0, count: 0 }
        byBranch[id].total += p.totalCost ?? 0
        byBranch[id].count++
      }
      const ranked  = Object.values(byBranch).sort((a, b) => b.total - a.total)
      const grandTotal = ranked.reduce((s, b) => s + b.total, 0)
      lines.push(`**Expenses by Station** — ${range.label}`)
      if (ranked.length === 0) {
        lines.push(`  No purchase data for this period.`)
      } else {
        lines.push(`  Total across all stations: **${fmt(grandTotal)}**`)
        lines.push(``)
        ranked.forEach((b, i) => {
          const medal = i === 0 ? '::AlertTriangle::' : i === 1 ? '::Award::' : '  '
          lines.push(`  ${medal} ${i + 1}. **${b.name}**: ${fmt(b.total)} (${pct(b.total, grandTotal)}) · ${b.count} purchases`)
        })
        lines.push(``)
        lines.push(`**::Lightbulb:: Jesse's Take**`)
        const top = ranked[0]
        lines.push(`  **${top.name}** is spending the most at ${fmt(top.total)} (${pct(top.total, grandTotal)} of total). ${ranked.length > 1 ? `That's ${fmt(top.total - ranked[ranked.length - 1].total)} more than the lowest-spending station.` : ''}`)
      }

    } else if (intents.includes('profit')) {
      const [sales, wasteLogs] = await Promise.all([
        prisma.dishSale.findMany({
          where: { restaurantId, saleDate: { gte: range.start, lte: range.end } },
          select: { totalSaleAmount: true, calculatedFoodCost: true, branchId: true, branch: { select: { name: true } } },
        }),
        prisma.wasteLog.findMany({
          where: { restaurantId, date: { gte: range.start, lte: range.end } },
          select: { calculatedCost: true, branchId: true },
        }),
      ])
      const byBranch: Record<string, { name: string; revenue: number; cogs: number; waste: number }> = {}
      for (const s of sales) {
        const id = s.branchId
        if (!byBranch[id]) byBranch[id] = { name: s.branch.name, revenue: 0, cogs: 0, waste: 0 }
        byBranch[id].revenue += s.totalSaleAmount ?? 0
        byBranch[id].cogs    += s.calculatedFoodCost ?? 0
      }
      for (const w of wasteLogs) {
        const id = w.branchId
        if (byBranch[id]) byBranch[id].waste += w.calculatedCost ?? 0
      }
      const ranked = Object.values(byBranch)
        .map(b => ({ ...b, profit: b.revenue - b.cogs - b.waste, margin: b.revenue > 0 ? ((b.revenue - b.cogs - b.waste) / b.revenue) * 100 : 0 }))
        .sort((a, b) => b.profit - a.profit)

      lines.push(`**Profit by Station** — ${range.label}`)
      if (ranked.length === 0) {
        lines.push(`  No sales data for this period.`)
      } else {
        lines.push(``)
        ranked.forEach((b, i) => {
          const medal = i === 0 ? '::Star::' : i === 1 ? '::Award::' : '  '
          const sign  = b.profit >= 0 ? '::TrendingUp::' : '::TrendingDown::'
          lines.push(`  ${medal} **${i + 1}. ${b.name}**`)
          lines.push(`    Revenue: ${fmt(b.revenue)} · Food Cost: ${fmt(b.cogs)} · Waste: ${fmt(b.waste)}`)
          lines.push(`    ${sign} **${b.profit >= 0 ? 'Profit' : 'Loss'}: ${fmt(Math.abs(b.profit))}** (${b.margin.toFixed(1)}% margin)`)
        })
        lines.push(``)
        lines.push(`**::Lightbulb:: Jesse's Take**`)
        const top = ranked[0]
        const bottom = ranked[ranked.length - 1]
        if (ranked.length > 1 && bottom.profit < 0) {
          lines.push(`  **${top.name}** leads with ${fmt(top.profit)} profit. **${bottom.name}** is at a loss (${fmt(bottom.profit)}) — review its cost structure.`)
        } else if (ranked.length > 1) {
          const marginGap = top.margin - (ranked[ranked.length - 1].margin)
          lines.push(`  **${top.name}** has the best profit at ${fmt(top.profit)} (${top.margin.toFixed(1)}% margin). Gap to lowest station is ${marginGap.toFixed(1)} percentage points.`)
        } else {
          lines.push(`  **${top.name}**: ${fmt(top.profit)} profit at ${top.margin.toFixed(1)}% margin.`)
        }
      }

    } else {
      const sales = await prisma.dishSale.findMany({
        where: { restaurantId, saleDate: { gte: range.start, lte: range.end } },
        select: { totalSaleAmount: true, branchId: true, branch: { select: { name: true } }, quantitySold: true },
      })
      const byBranch: Record<string, { name: string; revenue: number; count: number }> = {}
      for (const s of sales) {
        const id = s.branchId
        if (!byBranch[id]) byBranch[id] = { name: s.branch.name, revenue: 0, count: 0 }
        byBranch[id].revenue += s.totalSaleAmount ?? 0
        byBranch[id].count++
      }
      const ranked    = Object.values(byBranch).sort((a, b) => b.revenue - a.revenue)
      const grandTotal = ranked.reduce((s, b) => s + b.revenue, 0)

      lines.push(`**Revenue by Station** — ${range.label}`)
      if (ranked.length === 0) {
        lines.push(`  No sales data for this period.`)
      } else {
        lines.push(`  Total: **${fmt(grandTotal)}** across ${ranked.length} station${ranked.length !== 1 ? 's' : ''}`)
        lines.push(``)
        ranked.forEach((b, i) => {
          const medal = i === 0 ? '::Star::' : i === 1 ? '::Award::' : '  '
          lines.push(`  ${medal} **${i + 1}. ${b.name}**: ${fmt(b.revenue)} (${pct(b.revenue, grandTotal)}) · ${b.count} sales`)
        })
        lines.push(``)
        lines.push(`**::Lightbulb:: Jesse's Take**`)
        const top = ranked[0]
        const share = grandTotal > 0 ? (top.revenue / grandTotal) * 100 : 0
        if (share > 60 && ranked.length > 1) {
          lines.push(`  **${top.name}** generates ${share.toFixed(0)}% of total revenue — heavily concentrated. Consider growing other stations.`)
        } else if (ranked.length > 1) {
          lines.push(`  **${top.name}** leads at ${fmt(top.revenue)} (${share.toFixed(0)}%). Revenue is ${share < 50 ? 'fairly balanced' : 'somewhat concentrated'} across stations.`)
        } else {
          lines.push(`  **${top.name}**: ${fmt(top.revenue)} in revenue.`)
        }
      }
    }
  }

  // ── Specific Ingredient Stock Level ──────────────────────────────────────────
  if (intents.includes('stock_level')) {
    const ingredientName = parseIngredientName(question)
    if (ingredientName) {
      const ingredientNameLower = ingredientName.toLowerCase()
      const candidateItems = await prisma.inventoryItem.findMany({
        where: { restaurantId, ...branchFilter },
        select: { name: true, quantity: true, unit: true, reorderLevel: true, branch: { select: { name: true } } },
        orderBy: { name: 'asc' },
      })
      const items = candidateItems.filter(i => i.name.toLowerCase().includes(ingredientNameLower))
      if (items.length === 0) {
        lines.push(`**Stock: "${ingredientName}"**`)
        lines.push(`  ::XCircle:: No ingredient matching that name found.`)
        lines.push(`  Try a shorter name — e.g. "potatoes" instead of "sweet potatoes".`)
      } else if (items.length === 1) {
        const i = items[0]
        const isLow = i.quantity <= (i.reorderLevel ?? 0)
        lines.push(`**${i.name}** — ${i.branch.name}`)
        lines.push(`  In stock: **${i.quantity} ${i.unit}**`)
        lines.push(`  Reorder at: ${i.reorderLevel ?? 0} ${i.unit}`)
        lines.push(`  Status: ${isLow ? '::AlertTriangle:: Low — needs restocking' : '::CheckCircle:: OK'}`)
      } else {
        lines.push(`**Stock: "${ingredientName}"** — ${items.length} match${items.length !== 1 ? 'es' : ''} across stations`)
        for (const i of items) {
          const isLow = i.quantity <= (i.reorderLevel ?? 0)
          lines.push(`  ${isLow ? '::AlertTriangle::' : '::CheckCircle::'} ${i.name} (${i.branch.name}): **${i.quantity} ${i.unit}**`)
        }
      }
    } else {
      lines.push(`I can look up a specific ingredient — try:`)
      lines.push(`  • "how many kgs of sweet potatoes do we have?"`)
      lines.push(`  • "how much milk is left?"`)
      lines.push(`  • "do we have Heineken Beer in stock?"`)
    }
  }

  // ── Low Stock ─────────────────────────────────────────────────────────────────
  if (intents.includes('low_stock')) {
    // Under one shared pool the stock belongs to the whole restaurant, so
    // filtering it by station would answer "nothing here" for every station
    // that is not Main — technically true and completely useless.
    const restaurantRow = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { sharedStock: true },
    })
    const stockIsShared = Boolean(restaurantRow?.sharedStock)
    const stockFilter = stockIsShared ? {} : branchFilter

    const items = await prisma.inventoryItem.findMany({
      where: { restaurantId, ...stockFilter, deletedAt: null, type: { not: 'prep' } },
      select: {
        id: true, name: true, quantity: true, reorderLevel: true, unit: true,
        branch: { select: { name: true } },
        // Needed to know what a normal delivery of this item looks like.
        purchases: {
          where: { deletedAt: null },
          select: { quantityPurchased: true, purchasedAt: true },
          orderBy: { purchasedAt: 'desc' },
          take: 3,
        },
      },
    })
    const branchLabel = stockIsShared || !targetBranch ? '' : ` · ${targetBranch.name}`
    const all  = items.length

    // Same rule the stock screen uses: a manager-set reorder level wins,
    // otherwise 15% of a typical delivery. Without the fallback, and with no
    // reorder levels set anywhere, "low stock" could only ever mean "already
    // finished" — which tells you the one thing it is too late to act on.
    const thresholdFor = (i: typeof items[number]) => {
      if (Number(i.reorderLevel) > 0) return Number(i.reorderLevel)
      if (i.purchases.length === 0) return 0
      const typical = i.purchases.reduce((s, p) => s + Number(p.quantityPurchased), 0) / i.purchases.length
      return typical * 0.15
    }

    const low  = items
      .map(i => { const threshold = thresholdFor(i); return { ...i, threshold } })
      // An item that is out counts however it was set up; one that is merely
      // running low needs a threshold to be running low against.
      .filter(i => Number(i.quantity) <= 0 || (i.threshold > 0 && Number(i.quantity) <= i.threshold))
      .map(i => ({ ...i, deficit: i.threshold - i.quantity, pctLeft: i.threshold > 0 ? (i.quantity / i.threshold) * 100 : 0 }))
      .sort((a, b) => a.pctLeft - b.pctLeft)

    const isRestockQuery = /restock|what\s+should|need\s+to\s+buy/i.test(question)

    if (low.length === 0) {
      lines.push(`**::CheckCircle:: Stock Alert${branchLabel}** — all ${all} item${all !== 1 ? 's are' : ' is'} at a healthy level`)
      lines.push(`  Nothing needs restocking right now.`)
    } else {
      const critical = low.filter(i => i.quantity <= 0)
      const urgent   = low.filter(i => i.quantity > 0 && i.pctLeft < 50)
      const warning  = low.filter(i => i.quantity > 0 && i.pctLeft >= 50)

      if (isRestockQuery) {
        lines.push(`**Restock Priority${branchLabel}** — ${low.length} item${low.length !== 1 ? 's' : ''} need attention`)
      } else {
        lines.push(`**::AlertTriangle:: Low Stock Alert${branchLabel}** — ${low.length} of ${all} item${all !== 1 ? 's' : ''} running low or out`)
      }
      lines.push(``)

      if (critical.length > 0) {
        lines.push(`**Out of Stock (${critical.length})**`)
        critical.slice(0, 5).forEach(i => lines.push(`  ::XCircle:: **${i.name}** — 0 ${i.unit} · ${i.branch.name}`))
        if (critical.length > 5) lines.push(`  ...and ${critical.length - 5} more`)
        lines.push(``)
      }

      if (urgent.length > 0) {
        lines.push(`**Nearly out (${urgent.length})**`)
        urgent.slice(0, 5).forEach(i => lines.push(`  ::AlertTriangle:: **${i.name}** — ${Number(i.quantity.toFixed(2))} ${i.unit} left, usually reordered around ${Number(i.threshold.toFixed(2))}`))
        if (urgent.length > 5) lines.push(`  ...and ${urgent.length - 5} more`)
        lines.push(``)
      }

      if (warning.length > 0) {
        lines.push(`**Getting low (${warning.length})**`)
        warning.slice(0, 5).forEach(i => lines.push(`  ::Clock:: **${i.name}** — ${Number(i.quantity.toFixed(2))} ${i.unit} left of a usual ${Number((i.threshold / 0.15).toFixed(0))} ${i.unit} delivery`))
        if (warning.length > 5) lines.push(`  ...and ${warning.length - 5} more`)
        lines.push(``)
      }

      lines.push(`**::Lightbulb:: Jesse's Take**`)
      if (critical.length > 0) {
        lines.push(`  ${critical.length} item${critical.length !== 1 ? 's are' : ' is'} completely out of stock. Restock **${critical[0].name}** first.`)
      } else if (urgent.length > 0) {
        lines.push(`  **${urgent[0].name}** is the most urgent — only ${Number(urgent[0].quantity.toFixed(2))} ${urgent[0].unit} left. Order soon to avoid stockouts.`)
      } else {
        lines.push(`  ${low.length} item${low.length !== 1 ? 's are' : ' is'} running low. Worth adding to the next order.`)
      }
    }
  }

  // ── Record Transaction ────────────────────────────────────────────────────────
  if (intents.includes('record_transaction')) {
    lines.push(`::Lightbulb:: I'm focused on **reporting** — I can answer questions about your revenue, expenses, profit, stock, and orders.`)
    lines.push(``)
    lines.push(`To record a transaction, use the **Transactions** page or the **Journal** section.`)
    lines.push(``)
    lines.push(`Can I help you with a report instead?`)
  }

  // ── Greeting ─────────────────────────────────────────────────────────────────
  // "thanks" / "ok" — close the exchange rather than answering a question that
  // was not asked. Reporting revenue at someone who just said thank you is the
  // clearest sign an assistant is not listening.
  if (intents.includes('acknowledgement') && intents.length === 1) {
    const replies = [
      `Anytime! Anything else you want to check?`,
      `Happy to help. Just ask if you need another number.`,
      `You're welcome — I'm here whenever you need the figures.`,
    ]
    lines.push(replies[Math.floor(Date.now() / 1000) % replies.length])
  }

  // "what can you do?" — say so plainly instead of guessing at a report.
  if (intents.includes('capabilities') && !intents.some(i => !['capabilities', 'greeting', 'acknowledgement'].includes(i))) {
    lines.push(`I'm **Jesse** — I read your restaurant's numbers and answer questions about them.`)
    lines.push(``)
    lines.push(`**Money**`)
    lines.push(`  "what's today's revenue?" · "profit this month" · "are we profitable?"`)
    lines.push(`  "what's our food cost?" · "biggest expenses" · "payment breakdown"`)
    lines.push(``)
    lines.push(`**Stock**`)
    lines.push(`  "any low stock?" · "what should I restock?" · "how much soy sauce do we have?"`)
    lines.push(``)
    lines.push(`**Sales**`)
    lines.push(`  "top dishes" · "how many orders today?" · "any pending orders?"`)
    lines.push(`  "which station made the most?" · "how much did we make from burgers?"`)
    lines.push(``)
    lines.push(`**Comparing and explaining**`)
    lines.push(`  "this week vs last week" · "are we improving?" · "why is profit down?"`)
    lines.push(``)
    lines.push(`**Recording**`)
    lines.push(`  "record an expense of 50,000 for fuel" · "we paid staff 250,000"`)
    lines.push(``)
    lines.push(`You can name a period ("in July", "last week") or a station ("at Banana Bar") in any question.`)
  }

  if (intents.includes('greeting') && intents.length === 1) {
    if (/\b(how\s+are\s+you|how'?s\s+it(\s+going)?|what'?s\s+up|sup)\b/i.test(question)) {
      const replies = [
        `I'm great, thanks for asking! Ready to pull your numbers whenever you are. What do you need?`,
        `Doing well! Ask me anything — revenue, expenses, stock levels, you name it.`,
        `All good and ready to help! What would you like to check today?`,
      ]
      lines.push(replies[Math.floor(Date.now() / 1000) % replies.length])
    } else {
      const hour = new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })
      const h = parseInt(hour, 10)
      const timeGreet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
      lines.push(`${timeGreet}! ::Zap:: I'm **Jesse** — your restaurant reporting assistant.`)
      lines.push(``)
      lines.push(`Ask me anything about your numbers:`)
      lines.push(`  ::Banknote:: "what's today's revenue?" / "this month's profit"`)
      lines.push(`  ::BarChart2:: "expenses station by station" / "profit by station this week"`)
      lines.push(`  ::Target:: "revenue by MoMo today" / "payment breakdown"`)
      lines.push(`  ::Flame:: "what's our best seller?" / "top dishes this month"`)
      lines.push(`  ::Clock:: "how many orders today?" / "pending orders right now"`)
      lines.push(`  ::AlertTriangle:: "how much milk do we have?" / "low stock alert"`)
      lines.push(`  ::TrendingUp:: "how's business today?" / "are we improving?"`)
      lines.push(`  ::Lightbulb:: "why is revenue low?" / "this week vs last week"`)
    }
  }

  // ── Fallback ──────────────────────────────────────────────────────────────────
  if (lines.length === 0) {
    lines.push(`::AlertTriangle:: I'm not sure how to answer that one.`)
    lines.push(``)
    lines.push(`I'm best at restaurant numbers. Try:`)
    lines.push(`  • "what's today's revenue?"`)
    lines.push(`  • "profit this week vs last week"`)
    lines.push(`  • "how many orders this month?"`)
    lines.push(`  • "what's our best seller?"`)
    lines.push(`  • "do we have any low stock?"`)
    lines.push(`  • "expenses by station this month"`)
    lines.push(`  • "how's business today?" — for a full snapshot`)
  }

  return NextResponse.json({
    answer: lines.join('\n'),
    period: range.label,
    intents,
    followUps: getFollowUps(intents, allBranches.length),
    source: 'restaurant-db',
  })
}

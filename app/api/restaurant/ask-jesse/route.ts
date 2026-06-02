import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { recordJournalEntry } from '@/lib/accounting'

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
  if (/salary|salaries|wage|wages|payroll|staff pay|employee pay|worker|labor|labour|bonus|overtime|commission payout|per diem|contractor pay|freelancer|allowance|reimburs|salary advance|payroll deduction|compensation|paye|internship stipend|coaching|mentoring fee/.test(t)) return 'Salaries & Wages'
  // Utilities
  if (/electric|electricity|water bill|utilities|utility|power bill/.test(t)) return 'Utilities'
  // Communication & Tech
  if (/telecom|phone bill|airtime|data bundle|internet|mobile data|communication|hosting fee|domain|cloud subscription|saas|api charges|server expense|it support|cybersecurity|software maintenance|tech upgrade|hardware|printer|network equipment|backup service|storage subscription|software renewal/.test(t)) return 'Technology & Telecom'
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

const TX_STOP = /\b(record|log|add|post|enter|a|transaction|entry|i|paid|received|spent|bought|purchased|earned|for|from|by|via|using|with|on|the|to|of|and|in|at|today|yesterday|cash|momo|bank|card|cheque)\b/gi

function parseSingleTransaction(seg: string): TxItem | null {
  const amount = extractAmount(seg)
  if (!amount) return null

  const date = extractTxDate(seg)
  const paymentMethod = extractTxPaymentMethod(seg)
  const isIncome = /\b(received|earned|income|revenue|sold|customer\s+paid|client\s+paid|payment\s+from|got\s+paid)\b/i.test(seg)
  const direction: 'in' | 'out' = isIncome ? 'in' : 'out'
  const accountName = direction === 'in' ? classifyIncomeAccount(seg) : classifyExpenseAccount(seg)

  const description = seg
    .replace(TX_STOP, ' ')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/gi, '')
    .replace(/\bon\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?\b/gi, '')
    .replace(/[\d,]+\s*(k|thousand)?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,.\-\s]+|[,.\-\s]+$/g, '')
    || (direction === 'in' ? 'Income' : 'General Expense')

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

type Intent =
  | 'revenue' | 'profit' | 'orders' | 'expenses' | 'waste' | 'food_cost'
  | 'payment' | 'top_dishes' | 'low_stock' | 'stock_level'
  | 'dish_query' | 'branch_comparison' | 'pending_orders' | 'avg_order'
  | 'greeting' | 'catchup' | 'trends' | 'why' | 'record_transaction'

function parseIntents(q: string): Intent[] {
  const s = new Set<Intent>()
  if (/\brevenue\b|\bsales\b|\bincome\b|\bhow much.*made\b|\bwe\s+made\b|\bearned\b|\bmade.*money\b/i.test(q)) s.add('revenue')
  if (/\bprofit\b|\bnet\s+profit\b|\bearning/i.test(q)) s.add('profit')
  if (/\bloss\b|\blosing\b/i.test(q)) s.add('profit')
  if (/\borders?\b|\bhow many\s+orders?\b|\bnumber\s+of\s+orders?\b|\bcount\s+orders?\b/i.test(q)) s.add('orders')
  if (/\bexpenses?\b|\bpurchases?\b|\bprocurement\b|\bspent\b|\bspend\b|\bsuppl(y|ier)\b|\binventory\s+cost\b/i.test(q)) s.add('expenses')
  if (/\bwaste\b|\bwasted\b|\bspoilage?\b|\bspoilt?\b/i.test(q)) s.add('waste')
  if (/\bfood\s*cost\b|\bcogs\b|\bcost\s*of\s*goods\b/i.test(q)) s.add('food_cost')
  if (/\btop\s*dish(es)?\b|\bbest.?sell\b|\bpopular\b|\bmost\s*ordered\b|\bbest\s*dish\b|\bbest\s*drink\b|\bour\s+best\b/i.test(q)) s.add('top_dishes')
  if (/\blow\s*stock\b|\brun(ning)?\s*out\b|\breorder\b|\bshortage\b|\bfinish(ing|ed)?\b/i.test(q)) s.add('low_stock')
  if (/\bmomo\b|\bmobile\s*money\b|\bbank\b|\bcheque\b|\bcheck\b|\bcard\b|\bcash\b|\bcredit\b|\bpayment\s*method\b|\bpaid\s*by\b|\bbreakdown\b/i.test(q)) s.add('payment')
  if (/\bin\s+stock\b|\bstock\s+level\b|\bstock\s+of\b|\bquantity\s+of\b|\bdo\s+we\s+have\b|\bhow\s+much\s+.{2,40}\s+(do\s+we|is\s+left|remaining|available)\b|\bhow\s+many\s+\w+\s+of\b/i.test(q)) s.add('stock_level')
  // Specific dish revenue/sales — "how much from burgers", "how many chicken wings did we sell"
  if (
    (/\b(revenue|sales|income|made|earned)\s+(from|of)\s+[a-z]/i.test(q) ||
     /\bhow\s+many\s+[a-z][\w\s]+\s+(did\s+we\s+sell|sold|were\s+sold)\b/i.test(q) ||
     /\bhow\s+much\s+(did\s+we\s+make\s+from|from)\s+[a-z]/i.test(q) ||
     /\b[a-z][\w\s]+\s+(sales|revenue)\s+(today|yesterday|this|last|past)\b/i.test(q)) &&
    !/\b(momo|cash|bank|cheque|card|credit)\b/i.test(q)
  ) s.add('dish_query')
  // Branch comparison — "which branch made the most", "revenue by branch", "expenses branch by branch"
  if (/\bwhich\s+branch\b|\bbranch(es)?\s+(comparison|performance|revenue|sales|ranking)\b|\brevenue\s+by\s+branch\b|\btop\s+branch\b|\bper\s+branch\b|\bbranch\s+by\s+branch\b|\bby\s+branch\b/i.test(q)) s.add('branch_comparison')
  // Pending / outstanding orders right now
  if (/\bpending\s+orders?\b|\boutstanding\s+orders?\b|\bopen\s+orders?\b|\borders?\s+(still\s+)?(pending|open|outstanding)\b|\bright\s+now\b.*orders?\b|\borders?.*right\s+now\b/i.test(q)) s.add('pending_orders')
  // Average order value
  if (/\baverage\s+(order|sale|transaction|value|revenue)\b|\bavg\s+(order|sale|value)\b/i.test(q)) s.add('avg_order')
  // ── Greeting ─────────────────────────────────────────────────────────────────
  if (/^(hi+|hello+|hey+|good\s*(morning|afternoon|evening|day|night)|howdy|greetings|morning|evening|afternoon|how\s+are\s+you|how'?s\s+it(\s+going)?|what'?s\s+up|sup|yo|salut|bonjour|hola|jambo|muraho|niaje|habari|mwaramutse|amakuru)\b/i.test(q.trim())) s.add('greeting')
  // Record transaction — keyword/sentence based detection
  const hasAmount = /\b\d[\d,]*\s*(k|thousand)?\b/i.test(q)
  const isQuery = /\b(how much|how many|what did|what are|how little|which|show me|list|total|summary|report)\b/i.test(q)
  if (!isQuery && !s.has('pending_orders') && !s.has('avg_order') && (
    // ── Clear recording commands (no amount needed) ──
    /\b(record\s+this|log\s+this|save\s+this\s+(transaction|expense|record|payment)|add\s+this\s+entry|create\s+(an?\s+)?entry|book\s+this\s+transaction|register\s+this\s+payment|enter\s+this\s+expense|post\s+this\s+entry|journalize(\s+this)?|add\s+to\s+(ledger|books)|create\s+(accounting|bookkeeping)\s+(record|entry)|process\s+payroll|close\s+the\s+books|reconcile\s+account|bank\s+reconciliation|accrue\s+this|defer\s+this\s+revenue|capitalize\s+this|amortize\s+this|write\s+off\s+the|reverse\s+accrual|update\s+trial\s+balance|reflect\s+in\s+p.?l|update\s+balance\s+sheet|note\s+this\s+transaction|track\s+this\s+(purchase|payment|expense)|capture\s+this\s+expense|save\s+record|sync\s+transaction|post\s+to\s+ledger)\b/i.test(q) ||
    // ── Explicit record triggers with category ──
    /\b(record|log|add|post|enter)\s+(?:a\s+)?(?:transaction|entry|expense|income|payment|sale|purchase|journal|payroll|salary|refund|invoice|deposit|loan|asset|depreciation)\b/i.test(q) ||
    // ── Income / Revenue sentence phrases ──
    /\b(received\s+payment|got\s+paid|client\s+(paid|cleared|settled)|customer\s+(paid|settled|cleared)|invoice\s+was\s+paid|received\s+money|money\s+came\s+in|received\s+deposit|got\s+revenue|earned\s+income|collected\s+cash|received\s+transfer|payment\s+received|booked\s+revenue|sales\s+came\s+in|cash\s+received\s+today|money\s+received\s+today|the\s+client\s+finally\s+paid|customer\s+cleared\s+(their\s+)?balance|supplier\s+refunded\s+us|refund\s+received|cashback\s+received|settlement\s+received|installment\s+received|financing\s+received|funding\s+secured|investment\s+received|dividend\s+received|remittance\s+received|claim\s+received|insurance\s+payout|we\s+received\s+cash)\b/i.test(q) ||
    // ── Expense / Payment sentence phrases ──
    /\b(settled\s+the\s+bill|cleared\s+the\s+invoice|paid\s+(supplier|vendor|employees|staff|salary|wages|rent|invoice|contractor|freelancer|tax|vat|insurance|utility|bill|interest|loan|penalty|fee)|paid\s+via\s+(mtn|airtel|momo|bank|card)|processed\s+payroll|salary\s+paid|wages\s+paid|staff\s+payment|payroll\s+processed|commission\s+paid|bonus\s+paid|allowance\s+paid|reimbursed\s+(employee|expense)|made\s+(a\s+)?payment|sent\s+payment|made\s+(a\s+)?transfer|transferred\s+funds|moved\s+money|bank\s+charged\s+fee|bank\s+deducted|withdrew\s+cash|deposited\s+cash|momo\s+payment|mobile\s+money\s+payment|card\s+was\s+charged|pos\s+payment|supplier\s+has\s+been\s+paid|employee\s+salaries\s+went\s+out|we\s+paid\s+for|we\s+(spent|bought|purchased)|covered\s+expenses|asset\s+acquired|equipment\s+(purchased|bought|installed)|record\s+depreciation|depreciate\s+asset|disposed\s+asset|sold\s+asset|asset\s+write.?off|subscription\s+renewed|monthly\s+payment\s+made|annual\s+fee\s+paid|insurance\s+premium\s+paid|maintenance\s+contract\s+renewed|standing\s+order\s+executed|advance\s+payment\s+made|prepayment\s+made|security\s+deposit\s+paid|escrow\s+payment|retention\s+payment|converted\s+currency|forex\s+(gain|loss)\s+recorded|international\s+payment\s+sent|remittance\s+sent|owner\s+(invested|withdrew)|shareholder\s+contribution|capital\s+injected|dividend\s+paid|drawings\s+recorded|profit\s+reinvested|equity\s+contribution|customer\s+refunded|refund\s+issued|credit\s+note\s+issued|discount\s+(applied|given)|purchase\s+returned|sales\s+return|damaged\s+goods\s+returned)\b/i.test(q) ||
    // ── Natural conversational phrases ──
    /\b(please\s+save\s+this\s+expense|add\s+this\s+to\s+(accounting|books)|I\s+need\s+this\s+recorded|log\s+the\s+(utility|fuel|salary|rent|payroll|water|electricity|internet)\s+payment|record\s+today.?s\s+sales|track\s+this\s+payment|register\s+the\s+incoming\s+transfer|the\s+bank\s+deducted\s+charges|fix\s+the\s+duplicate\s+transaction|remove\s+the\s+wrong\s+entry|adjust\s+the\s+(final\s+)?balance|update\s+the\s+(invoice|record|financials))\b/i.test(q) ||
    // ── With amounts: action words + number ──
    (hasAmount && (
      /\b(paid|spent|bought|purchased|received|earned|sold|withdrew|deposited)\s+[\d,]+/i.test(q) ||
      /\b[\d,]+\s*(k\b)?\s+(for|on)\s+\w/i.test(q) ||
      /\b(fuel|diesel|petrol|rent|salary|wages|payroll|electricity|water|internet|airtime|repair|maintenance|supplies|insurance|tax|vat|paye|cleaning|transport|delivery|bonus|overtime|commission\s+payout|per\s+diem|contractor|allowance|equipment|vehicle|laptop|machinery|furniture|capex|depreciation|loan\s+repayment|installment|mortgage|dividend|drawings|petty\s+cash|shipping|freight|customs|logistics|marketing|advertising|legal\s+fee|audit\s+fee|consultancy|training|workshop|seminar|school\s+fees|membership|donation|interest\s+expense|bank\s+fee|hosting|domain|saas|cloud|hardware|phone\s+bill|data\s+bundle|telecom|insurance\s+premium|procurement|sourcing|packaging|warehousing|sponsorship|branding|pr\s+expense|permit\s+fee|registration\s+fee|government\s+fee|oil\s+change|tire|security\s+deposit|advance\s+payment|prepayment|reimbursement|settlement)\s+[\d,]+/i.test(q) ||
      /\b(expense|payment|bill|invoice|fee|charge|cost)\s+of\s+[\d,]+/i.test(q) ||
      /\b(utility|travel|fuel|maintenance|operating|staff|payroll|rent|office|software|subscription|telecom|legal|marketing|advertising|promotion|training|insurance|procurement|logistics|shipping|delivery|courier|freight|transport|storage|cleaning|security|repair|it\s+support|hosting|domain|saas|cloud|hardware|donation|membership|education|workshop|seminar)\s+expense\b/i.test(q)
    )) ||
    // ── Accounting-specific terms (always record intent) ──
    /\b(journal\s+entry|ledger\s+entry|bookkeeping|accrual|adjustment\s+entry|reversal\s+entry|adjusting\s+entry|closing\s+entry|accrue\s+this|defer\s+this|capitalize\s+this\s+cost|amortize\s+this|recognize\s+the\s+revenue|impair\s+the\s+asset|allocate\s+overhead|distribute\s+cost|journalize\s+this|create\s+adjusting\s+entry|close\s+(revenue|expense)\s+account|record\s+retained\s+earnings)\b/i.test(q)
  )) s.add('record_transaction')

  // Catch-up — "how's business?", "how are we doing?", "give me a summary", "anything I should know?"
  if (/\b(how.?s\s*business|how\s+are\s+we\s+doing|how.?s\s+today|how.?s\s+it\s+going|what.?s\s+the\s+situation|give\s+me\s+a\s+summary|anything\s+(new|i\s+should\s+know)|what.?s\s+up|catch\s+me\s+up|update\s+me|what\s+happened\s+today|daily\s+recap|overview|snapshot)\b/i.test(q)) s.add('catchup')
  // Trends — "trending?", "are we improving?", "this week vs last", "compare periods"
  if (/\b(trend(ing)?|improving|getting\s+better|getting\s+worse|this\s+week\s+vs|last\s+week\s+vs|compare\s+(to|with)\s+(last|previous)|versus\s+last|period\s+over\s+period|week\s+on\s+week|month\s+on\s+month|are\s+we\s+(up|down|growing|declining))\b/i.test(q)) s.add('trends')
  // Why — "why is X low?", "what caused this?", "explain", or bare "why?"
  if (/\b(why(\s+is|\s+are|\s+did|\s+has|\s+were)?|what\s+caused|what.?s\s+causing|explain(\s+this|\s+the|\s+why)?|what\s+went\s+wrong|what.?s\s+the\s+reason|how\s+come|tell\s+me\s+why)\b/i.test(q)) s.add('why')

  if (s.size === 0) s.add('revenue')
  return [...s]
}

// ── Follow-up chip suggestions per intent ────────────────────────────────────
function getFollowUps(intents: Intent[], branchCount: number): string[] {
  const has = (i: Intent) => intents.includes(i)
  if (has('catchup') || (has('greeting') && intents.length === 1)) {
    return ["Today's revenue?", 'Any pending orders?', 'Low stock alert?']
  }
  if (has('why')) {
    return ['Compare to last month', 'Which branch caused it?', 'Show me the breakdown']
  }
  if (has('trends')) {
    return ['This month vs last month', 'Which branch is growing?', "What's profit looking like?"]
  }
  if (has('branch_comparison')) {
    return ['Profit by branch', 'Expenses by branch', 'Best performer this month?']
  }
  if (has('profit')) {
    return branchCount > 1
      ? ['Which branch leads?', "What's driving food cost?", 'Compare to last week']
      : ["What's the food cost?", 'Revenue this month?', 'Compare to last week']
  }
  if (has('revenue')) {
    return branchCount > 1
      ? ['Break it down by branch', 'What about expenses?', 'Why is revenue low?']
      : ['What about expenses?', 'Profit this period?', 'Compare to last week']
  }
  if (has('expenses')) {
    return ["What's the profit?", 'Which branch spends most?', 'Revenue vs expenses']
  }
  if (has('orders')) {
    return ["What's the revenue?", 'Pending orders right now?', 'Average order value?']
  }
  if (has('top_dishes')) {
    return ['Revenue from top dish?', 'Which branch sells it most?', "What's the profit this month?"]
  }
  if (has('low_stock')) {
    return ['Show full stock list', 'What should I restock first?', 'Expenses this week?']
  }
  if (has('payment')) {
    return ['Total revenue this period?', "What's the profit?", 'Orders this week?']
  }
  if (has('record_transaction')) {
    return ["Today's expenses?", "What's today's profit?", 'Revenue this week?']
  }
  if (has('waste')) {
    return ['How does waste affect profit?', 'Expenses this week?', "What's the food cost?"]
  }
  if (has('stock_level')) {
    return ['Any low stock?', 'Record a purchase', 'Inventory expenses this month?']
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

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId) return NextResponse.json({ error: 'No restaurant found' }, { status: 400 })

  const { restaurantId } = context

  const body = await req.json().catch(() => null)

  // ── Excel / CSV import ────────────────────────────────────────────────────────
  if (Array.isArray(body?.importRows) && body.importRows.length > 0) {
    const importRows = body.importRows as Record<string, unknown>[]
    const fileName: string = body.fileName ?? 'file'
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

    const lines: string[] = []
    let successCount = 0
    let skipCount = 0
    const resultLines: string[] = []

    for (const row of importRows) {
      // Amount — direct column OR computed (Cost × Qty, Price × Qty)
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

      // Description — keyword prompt for account classification
      const description = col(row, ...DESCRIPTION_COLS)

      // Date
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

      // Direction — from type column or description keywords
      const typeRaw = col(row, ...TYPE_COLS).toLowerCase()
      let direction: 'in' | 'out'
      if (/income|revenue|\bin\b|credit|received|sales|earning|inflow|cash\s*in/.test(typeRaw)) direction = 'in'
      else if (/expense|\bout\b|debit|paid|cost|payment|outflow|cash\s*out/.test(typeRaw)) direction = 'out'
      else direction = /\b(received|earned|income|revenue|sales|sold|customer\s+paid|got\s+paid|money\s+in|cash\s+in|inflow)\b/i.test(description) ? 'in' : 'out'

      // Account classification using description as keyword prompt
      const prompt = `${description} ${typeRaw}`
      const accountName = direction === 'in' ? classifyIncomeAccount(prompt) : classifyExpenseAccount(prompt)

      // Payment method
      const pmRaw = col(row, ...PAYMENT_COLS)
      let paymentMethod = 'Cash'
      if (/momo|mobile\s*money|mtn|airtel\s*money/i.test(pmRaw)) paymentMethod = 'MoMo'
      else if (/bank|transfer|cheque|check|wire|rtgs|eft|swift|direct\s*debit|standing\s*order/i.test(pmRaw)) paymentMethod = 'Bank'
      else if (/card|visa|mastercard|pos|debit\s*card|credit\s*card/i.test(pmRaw)) paymentMethod = 'Card'

      try {
        await recordJournalEntry(prisma, {
          restaurantId,
          date,
          description: description || accountName,
          amount,
          direction,
          accountName,
          categoryType: direction === 'in' ? 'income' : 'expense',
          paymentMethod,
        })
        const arrow = direction === 'in' ? '::TrendingUp::' : '::TrendingDown::'
        const dateLabel = date.toLocaleDateString('en-RW', { day: 'numeric', month: 'short', year: '2-digit' })
        resultLines.push(`  ${arrow} **${fmt(amount)}** · ${accountName} · ${paymentMethod} · ${dateLabel}${description ? ` · ${description.slice(0, 45)}` : ''}`)
        successCount++
      } catch {
        resultLines.push(`  ::XCircle:: Skipped: ${description || 'row'} — ${fmt(amount)}`)
        skipCount++
      }
    }

    lines.push(`**Excel Import — ${fileName}** · ${importRows.length} row${importRows.length !== 1 ? 's' : ''} found`)
    lines.push(...resultLines.slice(0, 50))
    if (resultLines.length > 50) lines.push(`  ...and ${resultLines.length - 50} more entries`)
    lines.push(`  ─`)
    if (successCount > 0) {
      lines.push(`  ::CheckCircle:: **${successCount} transaction${successCount !== 1 ? 's' : ''} recorded** and visible in the Journal.`)
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
  const branchLabel  = targetBranch ? targetBranch.name : 'All Branches'
  const lines: string[] = []

  // ── CAT 1: CATCH-UP — real business snapshot ─────────────────────────────────
  if (intents.includes('catchup')) {
    const todayStr  = kigaliDateStr()
    const todayStart = kigaliStart(todayStr)
    const todayEnd   = kigaliEnd(todayStr)
    const yesterdayStr = kigaliDateStr(shiftDays(todayStart, -1))

    const [todaySales, yesterdaySales, pendingOrders, lowStockItems] = await Promise.all([
      prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: todayStart, lte: todayEnd } }, select: { totalSaleAmount: true } }),
      prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: kigaliStart(yesterdayStr), lte: kigaliEnd(yesterdayStr) } }, select: { totalSaleAmount: true } }),
      prisma.restaurantOrder.findMany({ where: { restaurantId, status: { in: ['PENDING', 'OPEN'] } }, select: { id: true } }),
      prisma.inventoryItem.findMany({ where: { restaurantId }, select: { name: true, quantity: true, reorderLevel: true } }),
    ])

    const todayRev     = todaySales.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
    const yesterdayRev = yesterdaySales.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
    const trend        = yesterdayRev > 0 ? ((todayRev - yesterdayRev) / yesterdayRev) * 100 : null
    const lowStock     = lowStockItems.filter(i => i.quantity <= (i.reorderLevel ?? 0))

    const hour = new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })
    const h = parseInt(hour, 10)
    const greet = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening'

    lines.push(`::Zap:: **${greet}! Here's the snapshot.**`)
    lines.push(``)
    lines.push(`  ::Banknote:: **Revenue today:** ${fmt(todayRev)}${trend !== null ? `  ·  ${trend >= 0 ? '::TrendingUp::' : '::TrendingDown::'} ${trend >= 0 ? '+' : ''}${trend.toFixed(0)}% vs yesterday` : ''}`)
    lines.push(`  ::Clock:: **Pending orders:** ${pendingOrders.length === 0 ? 'None right now' : `${pendingOrders.length} order${pendingOrders.length !== 1 ? 's' : ''} waiting`}`)
    if (lowStock.length === 0) {
      lines.push(`  ::CheckCircle:: **Stock:** All levels OK`)
    } else {
      const names = lowStock.slice(0, 3).map(i => i.name).join(', ')
      lines.push(`  ::AlertTriangle:: **Low stock:** ${names}${lowStock.length > 3 ? ` +${lowStock.length - 3} more` : ''}`)
    }
    if (allBranches.length > 1) {
      lines.push(`  ::BarChart2:: **Branches active:** ${allBranches.length}`)
    }
    return NextResponse.json({ answer: lines.join('\n'), period: 'Today', intents, followUps: getFollowUps(intents, allBranches.length), source: 'restaurant-db' })
  }

  // ── CAT 3: WHY — comparative reasoning using context ─────────────────────────
  if (intents.includes('why') && !intents.includes('record_transaction')) {
    // Figure out what "why" refers to — check current question first, then prev question
    const subject = question + ' ' + prevQuestion
    const prevIntents = prevQuestion ? parseIntents(prevQuestion) : []
    const whyAbout: Intent[] = prevIntents.length > 0
      ? prevIntents.filter(i => !['greeting', 'catchup', 'why', 'trends'].includes(i)) as Intent[]
      : (parseIntents(subject).filter(i => !['why'].includes(i)) as Intent[])
    const primaryAbout = whyAbout[0] ?? 'revenue'

    const todayStr   = kigaliDateStr()
    const todayStart = kigaliStart(todayStr)
    const todayEnd   = kigaliEnd(todayStr)
    const range7     = { start: kigaliStart(kigaliDateStr(shiftDays(todayStart, -6))), end: kigaliEnd(todayStr) }
    const range7prev = { start: kigaliStart(kigaliDateStr(shiftDays(todayStart, -13))), end: kigaliEnd(kigaliDateStr(shiftDays(todayStart, -7))) }

    if (primaryAbout === 'revenue' || primaryAbout === 'profit') {
      const [thisWeek, lastWeek, topDishes, byBranch] = await Promise.all([
        prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: range7.start, lte: range7.end } }, select: { totalSaleAmount: true, calculatedFoodCost: true, paymentMethod: true } }),
        prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: range7prev.start, lte: range7prev.end } }, select: { totalSaleAmount: true } }),
        prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: range7.start, lte: range7.end } }, select: { totalSaleAmount: true, dish: { select: { name: true } } }, orderBy: { totalSaleAmount: 'desc' }, take: 3 }),
        allBranches.length > 1
          ? prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: range7.start, lte: range7.end } }, select: { totalSaleAmount: true, branchId: true, branch: { select: { name: true } } } })
          : Promise.resolve([] as { totalSaleAmount: number | null; branchId: string; branch: { name: string } }[]),
      ])

      const thisRev = thisWeek.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
      const lastRev = lastWeek.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
      const delta   = lastRev > 0 ? ((thisRev - lastRev) / lastRev) * 100 : null

      lines.push(`**Why ${primaryAbout === 'profit' ? 'profit' : 'revenue'} looks the way it does** — past 7 days`)
      lines.push(``)

      // Week-on-week
      if (delta !== null) {
        const icon = delta >= 0 ? '::TrendingUp::' : '::TrendingDown::'
        lines.push(`  ${icon} This week **${fmt(thisRev)}** vs last week **${fmt(lastRev)}** — ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`)
      } else {
        lines.push(`  This week: **${fmt(thisRev)}**`)
      }

      // Payment method breakdown
      const byMethod: Record<string, number> = {}
      for (const s of thisWeek) {
        const m = s.paymentMethod ?? 'Cash'
        byMethod[m] = (byMethod[m] ?? 0) + (s.totalSaleAmount ?? 0)
      }
      const topMethod = Object.entries(byMethod).sort((a, b) => b[1] - a[1])[0]
      if (topMethod) lines.push(`  ::Banknote:: Most revenue via **${topMethod[0]}** — ${fmt(topMethod[1])}`)

      // Top driver
      if (topDishes.length > 0) {
        lines.push(`  ::Flame:: Top seller: **${topDishes[0].dish?.name ?? '—'}** — ${fmt(topDishes[0].totalSaleAmount ?? 0)}`)
      }

      // Branch breakdown if multi-branch
      if (byBranch.length > 0) {
        const bMap: Record<string, { name: string; rev: number }> = {}
        for (const s of byBranch) {
          if (!bMap[s.branchId]) bMap[s.branchId] = { name: s.branch.name, rev: 0 }
          bMap[s.branchId].rev += s.totalSaleAmount ?? 0
        }
        const ranked = Object.values(bMap).sort((a, b) => b.rev - a.rev)
        lines.push(`  ::BarChart2:: **By branch:** ${ranked.map(b => `${b.name} ${fmt(b.rev)}`).join(' · ')}`)
      }

      // Zero revenue explanation
      if (thisRev === 0) {
        lines.push(``)
        lines.push(`  ::AlertTriangle:: No revenue recorded this week. Possible reasons:`)
        lines.push(`  • Orders not marked as PAID or COMPLETED`)
        lines.push(`  • Orders were created under a different time zone date`)
        lines.push(`  • No orders have been placed yet`)
      }

    } else if (primaryAbout === 'expenses') {
      const purchases = await prisma.inventoryPurchase.findMany({
        where: { restaurantId, purchasedAt: { gte: range7.start, lte: range7.end } },
        select: { totalCost: true, paymentMethod: true, ingredient: { select: { name: true } } },
        orderBy: { totalCost: 'desc' },
      })
      const total = purchases.reduce((s, p) => s + (p.totalCost ?? 0), 0)
      lines.push(`**Why expenses look the way they do** — past 7 days`)
      lines.push(`  Total: **${fmt(total)}** across ${purchases.length} purchase${purchases.length !== 1 ? 's' : ''}`)
      if (purchases.length > 0) {
        const top3 = purchases.slice(0, 3)
        lines.push(`  Top costs:`)
        top3.forEach(p => lines.push(`  • ${p.ingredient.name}: ${fmt(p.totalCost ?? 0)} (${p.paymentMethod ?? 'Cash'})`))
      }

    } else if (primaryAbout === 'orders') {
      const [thisOrders, lastOrders] = await Promise.all([
        prisma.restaurantOrder.count({ where: { restaurantId, createdAt: { gte: range7.start, lte: range7.end } } }),
        prisma.restaurantOrder.count({ where: { restaurantId, createdAt: { gte: range7prev.start, lte: range7prev.end } } }),
      ])
      const delta = lastOrders > 0 ? ((thisOrders - lastOrders) / lastOrders) * 100 : null
      lines.push(`**Why order count looks the way it does** — past 7 days`)
      lines.push(`  This week: **${thisOrders} orders**`)
      if (delta !== null) {
        const icon = delta >= 0 ? '::TrendingUp::' : '::TrendingDown::'
        lines.push(`  ${icon} ${delta >= 0 ? '+' : ''}${delta.toFixed(0)}% vs previous 7 days (${lastOrders} orders)`)
      }
      if (thisOrders === 0) {
        lines.push(`  ::AlertTriangle:: No orders this week — check if orders are being created and completed.`)
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
    const todayStr = kigaliDateStr()
    const todayD   = kigaliStart(todayStr)

    // This week vs last week
    const thisWeekStart = kigaliStart(kigaliDateStr(shiftDays(todayD, -6)))
    const lastWeekStart = kigaliStart(kigaliDateStr(shiftDays(todayD, -13)))
    const lastWeekEnd   = kigaliEnd(kigaliDateStr(shiftDays(todayD, -7)))

    const [thisWeek, lastWeek] = await Promise.all([
      prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: thisWeekStart, lte: kigaliEnd(todayStr) } }, select: { totalSaleAmount: true, calculatedFoodCost: true } }),
      prisma.dishSale.findMany({ where: { restaurantId, saleDate: { gte: lastWeekStart, lte: lastWeekEnd } }, select: { totalSaleAmount: true, calculatedFoodCost: true } }),
    ])

    const thisRev  = thisWeek.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
    const lastRev  = lastWeek.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
    const thisCogs = thisWeek.reduce((s, x) => s + (x.calculatedFoodCost ?? 0), 0)
    const lastCogs = lastWeek.reduce((s, x) => s + (x.calculatedFoodCost ?? 0), 0)
    const revDelta = lastRev > 0 ? ((thisRev - lastRev) / lastRev) * 100 : null
    const cogsDelta = lastCogs > 0 ? ((thisCogs - lastCogs) / lastCogs) * 100 : null

    lines.push(`**Trend — This week vs last week**`)
    lines.push(``)
    if (revDelta !== null) {
      const icon = revDelta >= 0 ? '::TrendingUp::' : '::TrendingDown::'
      const word = revDelta >= 1 ? 'Up' : revDelta <= -1 ? 'Down' : 'Flat'
      lines.push(`  ${icon} **Revenue ${word}** ${revDelta >= 0 ? '+' : ''}${revDelta.toFixed(1)}%`)
      lines.push(`  This week: **${fmt(thisRev)}** · Last week: ${fmt(lastRev)}`)
    } else {
      lines.push(`  This week: **${fmt(thisRev)}** · Last week: ${fmt(lastRev)}`)
    }
    if (cogsDelta !== null) {
      lines.push(`  Food cost: ${cogsDelta >= 0 ? '+' : ''}${cogsDelta.toFixed(1)}% vs last week`)
    }

    const profit = thisRev - thisCogs
    const prevProfit = lastRev - lastCogs
    const profitDelta = prevProfit > 0 ? ((profit - prevProfit) / prevProfit) * 100 : null
    if (profitDelta !== null) {
      const icon = profitDelta >= 0 ? '::TrendingUp::' : '::TrendingDown::'
      lines.push(`  ${icon} **Profit ${profitDelta >= 0 ? '+' : ''}${profitDelta.toFixed(1)}%** — ${fmt(profit)} this week vs ${fmt(prevProfit)} last`)
    }

    if (thisRev === 0 && lastRev === 0) {
      lines.push(`  ::AlertTriangle:: No sales data for either period.`)
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
    const sales = await prisma.dishSale.findMany({
      where: { restaurantId, ...branchFilter, saleDate: { gte: range.start, lte: range.end } },
      select: { totalSaleAmount: true, calculatedFoodCost: true, paymentMethod: true },
    })
    const totalRev  = sales.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
    const totalCogs = sales.reduce((s, x) => s + (x.calculatedFoodCost ?? 0), 0)

    if (intents.includes('payment')) {
      if (pmFilter) {
        const filtered = sales.filter(s => s.paymentMethod === pmFilter)
        const amount   = filtered.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
        lines.push(`**${pmFilter} Revenue** — ${range.label} · ${branchLabel}`)
        lines.push(`  Amount: **${fmt(amount)}** (${pct(amount, totalRev)} of total)`)
        lines.push(`  Orders: ${filtered.length}`)
      } else {
        const byMethod: Record<string, { amount: number; count: number }> = {}
        for (const s of sales) {
          const m = s.paymentMethod ?? 'Cash'
          if (!byMethod[m]) byMethod[m] = { amount: 0, count: 0 }
          byMethod[m].amount += s.totalSaleAmount ?? 0
          byMethod[m].count++
        }
        lines.push(`**Revenue by Payment Method** — ${range.label} · ${branchLabel}`)
        Object.entries(byMethod)
          .sort((a, b) => b[1].amount - a[1].amount)
          .forEach(([method, d]) => {
            lines.push(`  ${method}: **${fmt(d.amount)}** (${pct(d.amount, totalRev)}) · ${d.count} orders`)
          })
        lines.push(`  ─`)
        lines.push(`  Total: **${fmt(totalRev)}**`)
      }
    }

    if (intents.includes('revenue') && !intents.includes('payment')) {
      lines.push(`**Revenue** — ${range.label} · ${branchLabel}`)
      lines.push(`  Total: **${fmt(totalRev)}**`)
      if (totalRev === 0) {
        lines.push(`  ::AlertTriangle:: No completed orders found for this period.`)
        lines.push(`  Revenue is recorded when orders are marked PAID or COMPLETED.`)
      } else {
        lines.push(`  Dish Sales: ${sales.length}`)
      }
    }

    if (intents.includes('food_cost')) {
      lines.push(`**Food Cost** — ${range.label} · ${branchLabel}`)
      lines.push(`  COGS: **${fmt(totalCogs)}**`)
      lines.push(`  Food Cost %: **${pct(totalCogs, totalRev)}**`)
    }

    if (intents.includes('profit')) {
      const wasteLogs = await prisma.wasteLog.findMany({
        where: { restaurantId, ...branchFilter, date: { gte: range.start, lte: range.end } },
        select: { calculatedCost: true },
      })
      const wasteCost = wasteLogs.reduce((s, x) => s + (x.calculatedCost ?? 0), 0)
      const profit    = totalRev - totalCogs - wasteCost
      lines.push(`**Profit & Loss** — ${range.label} · ${branchLabel}`)
      lines.push(`  Revenue:   **${fmt(totalRev)}**`)
      lines.push(`  Food Cost: ${fmt(totalCogs)} (${pct(totalCogs, totalRev)})`)
      lines.push(`  Waste:     ${fmt(wasteCost)} (${pct(wasteCost, totalRev)})`)
      lines.push(`  ─`)
      lines.push(`  **${profit >= 0 ? '::TrendingUp:: Profit' : '::TrendingDown:: Loss'}: ${fmt(Math.abs(profit))} (${pct(Math.abs(profit), totalRev)})**`)
    }
  }

  // ── Orders ───────────────────────────────────────────────────────────────────
  if (intents.includes('orders') && !intents.includes('pending_orders')) {
    const orders = await prisma.restaurantOrder.findMany({
      where: { restaurantId, ...branchFilter, createdAt: { gte: range.start, lte: range.end } },
      select: { status: true, totalAmount: true },
    })
    const completed = orders.filter(o => ['COMPLETED', 'PAID'].includes(o.status ?? '')).length
    const pending   = orders.filter(o => ['PENDING', 'OPEN'].includes(o.status ?? '')).length
    const totalAmt  = orders.reduce((s, o) => s + (o.totalAmount ?? 0), 0)
    lines.push(`**Orders** — ${range.label} · ${branchLabel}`)
    lines.push(`  Total: **${orders.length}**`)
    lines.push(`  Completed: ${completed}  ·  Pending: ${pending}`)
    lines.push(`  Order Value: ${fmt(totalAmt)}`)
  }

  // ── Pending Orders (right now, no date filter) ────────────────────────────────
  if (intents.includes('pending_orders')) {
    const pending = await prisma.restaurantOrder.findMany({
      where: { restaurantId, ...branchFilter, status: { in: ['PENDING', 'OPEN'] } },
      select: { status: true, totalAmount: true, table: { select: { name: true } }, branch: { select: { name: true } } },
    })
    const totalAmt = pending.reduce((s, o) => s + (o.totalAmount ?? 0), 0)
    lines.push(`**Pending Orders Right Now** — ${branchLabel}`)
    lines.push(`  Count: **${pending.length}**`)
    lines.push(`  Total Value: ${fmt(totalAmt)}`)
    if (pending.length > 0) {
      const byBranch: Record<string, number> = {}
      for (const o of pending) {
        const b = o.branch?.name ?? 'Unknown'
        byBranch[b] = (byBranch[b] ?? 0) + 1
      }
      Object.entries(byBranch).forEach(([b, count]) => lines.push(`  ${b}: ${count} order${count !== 1 ? 's' : ''}`))
    }
  }

  // ── Average Order Value ───────────────────────────────────────────────────────
  if (intents.includes('avg_order')) {
    const orders = await prisma.restaurantOrder.findMany({
      where: { restaurantId, ...branchFilter, createdAt: { gte: range.start, lte: range.end } },
      select: { totalAmount: true },
    })
    const totalAmt = orders.reduce((s, o) => s + (o.totalAmount ?? 0), 0)
    const avg      = orders.length > 0 ? totalAmt / orders.length : 0
    lines.push(`**Average Order Value** — ${range.label} · ${branchLabel}`)
    lines.push(`  Average: **${fmt(avg)}**`)
    lines.push(`  Based on ${orders.length} order${orders.length !== 1 ? 's' : ''} · Total: ${fmt(totalAmt)}`)
  }

  // ── Expenses ─────────────────────────────────────────────────────────────────
  if (intents.includes('expenses') && !intents.includes('branch_comparison') && !intents.includes('record_transaction')) {
    const purchases = await prisma.inventoryPurchase.findMany({
      where: { restaurantId, ...branchFilter, purchasedAt: { gte: range.start, lte: range.end } },
      select: { totalCost: true, paymentMethod: true },
    })
    const total = purchases.reduce((s, p) => s + (p.totalCost ?? 0), 0)
    lines.push(`**Expenses** — ${range.label} · ${branchLabel}`)
    lines.push(`  Inventory Purchases: **${fmt(total)}**`)
    lines.push(`  Transactions: ${purchases.length}`)
    if (purchases.length > 0) {
      const byMethod: Record<string, number> = {}
      for (const p of purchases) {
        const m = p.paymentMethod ?? 'Cash'
        byMethod[m] = (byMethod[m] ?? 0) + (p.totalCost ?? 0)
      }
      Object.entries(byMethod)
        .sort((a, b) => b[1] - a[1])
        .forEach(([m, amt]) => lines.push(`  ${m}: ${fmt(amt)}`))
    }
  }

  // ── Waste ─────────────────────────────────────────────────────────────────────
  if (intents.includes('waste')) {
    const wasteLogs = await prisma.wasteLog.findMany({
      where: { restaurantId, date: { gte: range.start, lte: range.end } },
      select: { calculatedCost: true },
    })
    const total = wasteLogs.reduce((s, w) => s + (w.calculatedCost ?? 0), 0)
    lines.push(`**Waste** — ${range.label} · All Branches`)
    lines.push(`  Total Loss: **${fmt(total)}**`)
    lines.push(`  Incidents: ${wasteLogs.length}`)
  }

  // ── Top Dishes — defaults to This Month when no time period given ─────────────
  if (intents.includes('top_dishes')) {
    const dishRange = hasExplicitTimePeriod(question) ? range : thisMonthRange()
    const sales = await prisma.dishSale.findMany({
      where: { restaurantId, saleDate: { gte: dishRange.start, lte: dishRange.end } },
      include: { dish: { select: { name: true } } },
    })
    const map: Record<string, { name: string; revenue: number; qty: number }> = {}
    for (const s of sales) {
      if (!map[s.dishId]) map[s.dishId] = { name: s.dish.name, revenue: 0, qty: 0 }
      map[s.dishId].revenue += s.totalSaleAmount ?? 0
      map[s.dishId].qty     += s.quantitySold ?? 0
    }
    const top = Object.values(map).sort((a, b) => b.revenue - a.revenue).slice(0, 5)
    lines.push(`**Top Dishes / Best Sellers** — ${dishRange.label}`)
    if (top.length === 0) {
      lines.push('  No sales data for this period.')
    } else {
      top.forEach((d, i) => lines.push(`  ${i + 1}. ${d.name} — **${fmt(d.revenue)}** (${d.qty} sold)`))
    }
  }

  // ── Specific Dish Query ───────────────────────────────────────────────────────
  if (intents.includes('dish_query')) {
    const dishName = parseDishName(question)
    if (dishName) {
      const sales = await prisma.dishSale.findMany({
        where: {
          restaurantId,
          saleDate: { gte: range.start, lte: range.end },
          dish: { name: { contains: dishName, mode: 'insensitive' } },
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
        lines.push(`**"${dishName}" Sales** — ${range.label} · All Branches`)
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
      const ranked = Object.values(byBranch).sort((a, b) => b.total - a.total)
      lines.push(`**Expenses by Branch** — ${range.label}`)
      if (ranked.length === 0) {
        lines.push('  No purchase data for this period.')
      } else {
        ranked.forEach((b, i) => {
          const medal = i === 0 ? '::AlertTriangle::' : i === 1 ? '::Award::' : '  '
          lines.push(`  ${medal} ${i + 1}. ${b.name}: **${fmt(b.total)}** (${b.count} purchases)`)
        })
        const top = ranked[0]
        lines.push(`  ─`)
        lines.push(`  **${top.name}** had the highest expenses at **${fmt(top.total)}**.`)
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
        .map(b => ({ ...b, profit: b.revenue - b.cogs - b.waste }))
        .sort((a, b) => b.profit - a.profit)
      lines.push(`**Profit by Branch** — ${range.label}`)
      if (ranked.length === 0) {
        lines.push('  No sales data for this period.')
      } else {
        ranked.forEach((b, i) => {
          const medal = i === 0 ? '::Star::' : i === 1 ? '::Award::' : '  '
          const sign  = b.profit >= 0 ? '::TrendingUp::' : '::TrendingDown::'
          lines.push(`  ${medal} ${i + 1}. ${b.name}`)
          lines.push(`    Revenue: ${fmt(b.revenue)}  ·  Food Cost: ${fmt(b.cogs)}  ·  Waste: ${fmt(b.waste)}`)
          lines.push(`    ${sign} **${b.profit >= 0 ? 'Profit' : 'Loss'}: ${fmt(Math.abs(b.profit))}**`)
        })
        const top = ranked[0]
        lines.push(`  ─`)
        lines.push(`  **${top.name}** had the most ${top.profit >= 0 ? 'profit' : 'losses'} at **${fmt(Math.abs(top.profit))}**.`)
      }
    } else {
      // Default: revenue by branch
      const sales = await prisma.dishSale.findMany({
        where: { restaurantId, saleDate: { gte: range.start, lte: range.end } },
        select: { totalSaleAmount: true, branchId: true, branch: { select: { name: true } } },
      })
      const byBranch: Record<string, { name: string; revenue: number; count: number }> = {}
      for (const s of sales) {
        const id = s.branchId
        if (!byBranch[id]) byBranch[id] = { name: s.branch.name, revenue: 0, count: 0 }
        byBranch[id].revenue += s.totalSaleAmount ?? 0
        byBranch[id].count++
      }
      const ranked = Object.values(byBranch).sort((a, b) => b.revenue - a.revenue)
      lines.push(`**Revenue by Branch** — ${range.label}`)
      if (ranked.length === 0) {
        lines.push('  No sales data for this period.')
      } else {
        ranked.forEach((b, i) => {
          const medal = i === 0 ? '::Star::' : i === 1 ? '::Award::' : '  '
          lines.push(`  ${medal} ${i + 1}. ${b.name}: **${fmt(b.revenue)}** (${b.count} sales)`)
        })
        const top = ranked[0]
        lines.push(`  ─`)
        lines.push(`  **${top.name}** had the most sales at **${fmt(top.revenue)}**.`)
      }
    }
  }

  // ── Specific Ingredient Stock Level ──────────────────────────────────────────
  if (intents.includes('stock_level')) {
    const ingredientName = parseIngredientName(question)
    if (ingredientName) {
      const items = await prisma.inventoryItem.findMany({
        where: { restaurantId, name: { contains: ingredientName, mode: 'insensitive' } },
        select: { name: true, quantity: true, unit: true, reorderLevel: true, branch: { select: { name: true } } },
        orderBy: { name: 'asc' },
      })
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
        lines.push(`**Stock: "${ingredientName}"** — ${items.length} match${items.length !== 1 ? 'es' : ''} across branches`)
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
    const items = await prisma.inventoryItem.findMany({
      where: { restaurantId },
      select: { name: true, quantity: true, reorderLevel: true, unit: true },
    })
    const low = items.filter(i => i.quantity <= (i.reorderLevel ?? 0))
    if (low.length === 0) {
      lines.push(`**Low Stock** — ::CheckCircle:: All items are above reorder levels!`)
    } else {
      lines.push(`**Low Stock Alert** — ${low.length} item${low.length !== 1 ? 's' : ''} need restocking`)
      low.slice(0, 10).forEach(i =>
        lines.push(`  ::AlertTriangle:: ${i.name}: ${i.quantity} ${i.unit} (reorder at ≤${i.reorderLevel})`)
      )
      if (low.length > 10) lines.push(`  ...and ${low.length - 10} more`)
    }
  }

  // ── Record Transaction ────────────────────────────────────────────────────────
  if (intents.includes('record_transaction')) {
    const segments = parseTransactionSegments(question)
    const txItems = segments.map(parseSingleTransaction).filter((x): x is TxItem => x !== null)

    if (txItems.length === 0) {
      lines.push(`**Transaction Recording** — ::AlertTriangle:: I need the amount to record this.`)
      lines.push(`  Include the amount and I'll handle the rest. Examples:`)
      lines.push(`  • "paid 50,000 for fuel today by MoMo"`)
      lines.push(`  • "received 200,000 from client via bank"`)
      lines.push(`  • "salary 300,000 paid today"`)
      lines.push(`  • "rent 80,000 by bank, diesel 45,000 cash"`)
      lines.push(`  • "Jan 10: client paid 500,000, Jan 12: rent 200,000"`)
    } else {
      let successCount = 0
      const recorded: string[] = []
      for (const tx of txItems) {
        try {
          await recordJournalEntry(prisma, {
            restaurantId,
            date: tx.date,
            description: tx.description || (tx.direction === 'in' ? tx.accountName : tx.accountName),
            amount: tx.amount,
            direction: tx.direction,
            accountName: tx.accountName,
            categoryType: tx.direction === 'in' ? 'income' : 'expense',
            paymentMethod: tx.paymentMethod,
          })
          const arrow = tx.direction === 'in' ? '::TrendingUp::' : '::TrendingDown::'
          const dateStr = tx.date.toLocaleDateString('en-RW', { day: 'numeric', month: 'short' })
          recorded.push(`  ${arrow} **${fmt(tx.amount)}** · ${tx.accountName} · ${tx.paymentMethod} · ${dateStr}${tx.description ? ` · ${tx.description}` : ''}`)
          successCount++
        } catch {
          recorded.push(`  ::XCircle:: Failed: ${tx.description || tx.accountName} (${fmt(tx.amount)})`)
        }
      }
      lines.push(`**Recording ${txItems.length > 1 ? txItems.length + ' Transactions' : 'Transaction'}**`)
      lines.push(...recorded)
      if (successCount > 0) {
        lines.push(`  ─`)
        lines.push(`  ::CheckCircle:: **${successCount} transaction${successCount !== 1 ? 's' : ''} recorded.** View in the Journal section.`)
      }
    }
  }

  // ── Greeting ─────────────────────────────────────────────────────────────────
  if (intents.includes('greeting') && intents.length === 1) {
    const hour = new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })
    const h = parseInt(hour, 10)
    const timeGreet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
    lines.push(`${timeGreet}! ::Zap:: I'm **Jesse**, your restaurant assistant.`)
    lines.push(``)
    lines.push(`Here's what you can ask me:`)
    lines.push(`  • "what's today's revenue?" / "this month's profit"`)
    lines.push(`  • "expenses branch by branch" / "profit by branch this week"`)
    lines.push(`  • "revenue by MoMo today" / "payment breakdown"`)
    lines.push(`  • "what's our best seller?" / "top dishes this month"`)
    lines.push(`  • "how many orders today?" / "pending orders right now"`)
    lines.push(`  • "how much milk do we have?" / "low stock alert"`)
  }

  // ── Fallback ──────────────────────────────────────────────────────────────────
  if (lines.length === 0) {
    lines.push(`Hmm, I'm not sure about that one. 🤔`)
    lines.push(``)
    lines.push(`I'm best at restaurant numbers. Try something like:`)
    lines.push(`  • "what's today's revenue?"`)
    lines.push(`  • "how many orders this week?"`)
    lines.push(`  • "what's our best seller?"`)
    lines.push(`  • "do we have any low stock?"`)
    lines.push(`  • "expenses this month"`)
    lines.push(`  • "paid 50,000 for fuel by MoMo" — to record a transaction`)
  }

  return NextResponse.json({
    answer: lines.join('\n'),
    period: range.label,
    intents,
    followUps: getFollowUps(intents, allBranches.length),
    source: 'restaurant-db',
  })
}

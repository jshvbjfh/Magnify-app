'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { Sparkles, Loader2, BookOpen, TrendingUp, CreditCard, ArrowLeftRight, BarChart3, FileText, RefreshCw, Download, Utensils, Package, CalendarRange, Store, Share2, ArrowUpRight } from 'lucide-react'
import { fmtDesc } from '@/lib/displayId'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { BranchBadge, useRestaurantBranch } from '@/contexts/RestaurantBranchContext'

type ReportTab = 'journal' | 'receivable' | 'payable' | 'cashflow' | 'balance' | 'income' | 'payment_methods' | 'dish_profit' | 'inventory_movement' | 'theoretical_inventory' | 'general' | 'upselling'

type UpsellServerRow = {
  serverKey: string
  serverName: string
  terminalAccount: string | null
  checks: number
  addonRate: number | null
  drinkAttachRate: number | null
  upsellRevenue: number
  upsellProfit: number
  upsellMargin: number
  profitPerCheck: number
  vsHouse: number | null
  ranked: boolean
  apc: number | null
}

type UpsellPairing = {
  key: string
  baseName: string
  attachName: string
  baseBills: number
  together: number
  attachRate: number
  profit: number
  margin: number
  confidence: 'high' | 'medium' | 'low'
}

type UpsellOpportunity = {
  key: string
  baseName: string
  attachName: string
  baseBills: number
  together: number
  houseRate: number
  bestServerName: string
  bestServerRate: number
  gapPoints: number
  missedProfit: number
}

type UpsellingData = {
  summary: {
    bills: number
    upsellRevenue: number
    upsellProfit: number
    upsellMargin: number
    profitPerBill: number
    opportunity: number
    topServerName: string | null
    topServerRate: number | null
  }
  rows: UpsellServerRow[]
  house: UpsellServerRow | null
  pairings: UpsellPairing[]
  opportunities: UpsellOpportunity[]
  meta: {
    totalChecks: number; serverChecks: number; selfOrderChecks: number
    checksWithoutServer: number; coveredChecks: number
    uncategorizedItems: number; uncostedAttachLines: number; pairingsTotal: number
  }
}

type BranchSummaryRow = {
  branchId: string
  branchName: string
  sales: number
  cost: number
  profit: number
  percentOfSales: number
  marginPercent: number
}
type Period = 'today' | 'week' | 'month' | 'quarter' | 'year'

type PaymentMethodEvent = {
  key: string
  pairId: string | null
  date: string
  createdAt: string | null
  paymentMethod: string
  amount: number
  description: string
  clientLabel: string
  itemLabel: string
}

type PaymentMethodSummary = {
  key: string
  label: string
  buttonLabel: string
  totalAmount: number
  count: number
  events: PaymentMethodEvent[]
}

function statusLabel(value: string | null | undefined) {
  if (!value) return 'PAID'
  return String(value).replace(/_/g, ' ')
}

const TABS: { id: ReportTab; label: string; short: string; icon: React.ElementType; desc: string }[] = [
  { id:'general',    label:'General Report',         short:'General',   icon:Store,          desc:'Sales, cost of goods sold and profit by station, across your whole restaurant account' },
  { id:'journal',    label:'Journal Ledger',         short:'Journal',   icon:BookOpen,       desc:'All recorded transactions in chronological order' },
  { id:'receivable', label:'Accounts Receivable',    short:'A/R',       icon:TrendingUp,     desc:'Money customers owe your business' },
  { id:'payable',    label:'Accounts Payable',       short:'A/P',       icon:CreditCard,     desc:'Money your business owes to suppliers' },
  { id:'cashflow',   label:'Cash Flow Statement',    short:'Cash Flow', icon:ArrowLeftRight, desc:'Cash inflows and outflows analysis' },
  { id:'balance',    label:'Balance Sheet',          short:'Balance',   icon:BarChart3,      desc:'Assets, liabilities and equity snapshot' },
  { id:'income',            label:'Income Statement (P&L)', short:'P&L',       icon:FileText,   desc:'Revenue, expenses and net profit' },
  { id:'payment_methods',   label:'Payment Methods',        short:'Payments',  icon:CreditCard, desc:'Track how much has been collected by each payment method and review the full payment history with date and time.' },
  { id:'dish_profit',       label:'Orders Report',          short:'Orders',      icon:Utensils,   desc:'Orders, waiter, status, quantity sold, cost, price, total price, revenue and profit' },
  { id:'inventory_movement', label:'Inventory Movement',    short:'Inventory',   icon:Package,    desc:'Opening stock, in-period purchases, usage, remaining quantity and stock value' },
  { id:'theoretical_inventory', label:'Theoretical Inventory', short:'Theory Inv', icon:Package, desc:'Opening stock, expected usage, waste, theoretical closing and variance versus actual stock' },
  { id:'upselling',         label:'Upsell & Attachments',   short:'Upsell',    icon:ArrowUpRight, desc:'Which product pairings make the most gross profit, where you are leaving money on the table, and which waiters reproduce it — across your whole restaurant account' },
]

// Tabs that report the whole restaurant account rather than the station the
// user is currently switched to. Showing the station badge above these reads as
// a filter that isn't being applied — an owner on Parking Bar would take the
// house upselling figures for Parking Bar's.
const RESTAURANT_WIDE_TABS = new Set<ReportTab>(['general', 'upselling'])

const PERIOD_LABELS: Record<Period, string> = {
  today:'Today', week:'Last 7 Days', month:'This Month', quarter:'This Quarter', year:'This Year'
}
const FRESH_FETCH_OPTIONS = { credentials: 'include' as const, cache: 'no-store' as const }

function formatLocalDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseLocalDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

function getDateRange(period: Period) {
  const now = new Date(); const end = formatLocalDate(now)
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  if (period==='today')   { return { start:end, end, label:'Today' } }
  if (period==='week')    { d.setDate(d.getDate()-6) }
  if (period==='month')   { d.setDate(1) }
  if (period==='quarter') {
    const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3
    d.setMonth(quarterStartMonth, 1)
  }
  if (period==='year')    { d.setMonth(0,1) }
  return { start: formatLocalDate(d), end, label:PERIOD_LABELS[period] }
}

function todayStr() {
  return formatLocalDate(new Date())
}

/** Returns every calendar date string between start and end inclusive. */
function allDatesInRange(start: string, end: string): string[] {
  const dates: string[] = []
  const cur = parseLocalDate(start)
  const last = parseLocalDate(end)
  while (cur <= last) {
    dates.push(formatLocalDate(cur))
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

function formatDayChip(date: string) {
  const value = parseLocalDate(date)
  return {
    weekday: value.toLocaleDateString('en-RW', { weekday: 'short' }),
    display: value.toLocaleDateString('en-RW', { month: 'numeric', day: 'numeric', year: 'numeric' }),
  }
}

function fmt(n: number) { return n.toLocaleString('en-RW',{maximumFractionDigits:0}) }

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function normalizeTransactions(rows: any[]) {
  return rows.map((row) => ({
    ...row,
    type: row.type ?? (row.direction === 'in' ? 'credit' : 'debit'),
    account: row.account ?? {
      name: row.accountName ?? '',
      category: {
        type: row.categoryType ?? '',
      },
    },
  }))
}

function isCashEquivalentAccountName(name?: string) {
  const normalized = (name ?? '').trim().toLowerCase()
  return normalized === 'cash'
    || normalized.includes('cash')
    || normalized === 'current account'
    || normalized.includes('bank')
    || normalized === 'mobile money'
    || normalized.includes('momo')
}

function isReceivableTransaction(tx: any) {
  const accountName = (tx.account?.name ?? '').trim().toLowerCase()
  return accountName.includes('receivable')
}

function isPayableTransaction(tx: any) {
  const accountName = (tx.account?.name ?? '').trim().toLowerCase()
  return accountName.includes('payable')
}

function getReceivableEffect(tx: any) {
  return tx.type === 'debit' ? tx.amount : -tx.amount
}

function getPayableEffect(tx: any) {
  return tx.type === 'credit' ? tx.amount : -tx.amount
}

function isIncomeTransaction(tx: any) {
  const accountName = (tx.account?.name ?? '').trim().toLowerCase()
  const categoryType = (tx.account?.category?.type ?? '').trim().toLowerCase()
  return categoryType === 'income' || /revenue|sales|income/.test(accountName)
}

function isExpenseTransaction(tx: any) {
  const accountName = (tx.account?.name ?? '').trim().toLowerCase()
  const categoryType = (tx.account?.category?.type ?? '').trim().toLowerCase()
  return categoryType === 'expense' || /expense|cost|wage|rent|utilities|labor|waste/.test(accountName)
}

function getIncomeEffect(tx: any) {
  return tx.type === 'credit' ? tx.amount : -tx.amount
}

function getExpenseEffect(tx: any) {
  return tx.type === 'debit' ? tx.amount : -tx.amount
}

const PAYMENT_METHOD_SORT_ORDER: Record<string, number> = {
  Cash: 1,
  'Mobile Money': 2,
  'Owner Momo': 3,
  Credit: 4,
  Bank: 5,
  'Notes Payable': 6,
  Unknown: 99,
}

function toTitleCase(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

function normalizePaymentMethodName(value: string | null | undefined) {
  const raw = String(value ?? '').trim()
  if (!raw) return 'Unknown'

  const normalized = raw.toLowerCase()
  if (normalized === 'cash') return 'Cash'
  if (normalized === 'momo' || normalized === 'mobile money') return 'Mobile Money'
  if (normalized === 'owner momo' || normalized === 'owner mobile money') return 'Owner Momo'
  if (normalized === 'credit') return 'Credit'
  if (normalized === 'bank' || normalized === 'current account' || normalized === 'transfer') return 'Bank'
  if (normalized === 'note payable' || normalized === 'notes payable') return 'Notes Payable'

  return toTitleCase(raw)
}

function paymentMethodButtonLabel(value: string) {
  if (value === 'Mobile Money') return 'MoMo'
  return value
}

function getTransactionTimestamp(tx: { date?: string | null; createdAt?: string | null }) {
  const candidate = tx.date || tx.createdAt || ''
  const timestamp = new Date(candidate).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function formatReportDateTime(value: string | null | undefined) {
  const timestamp = new Date(String(value ?? '')).getTime()
  if (!Number.isFinite(timestamp)) return 'Unknown time'

  return `${new Date(timestamp).toLocaleString('en-RW', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })} UTC+2`
}

function extractPaymentClientLabel(description: string) {
  const normalized = String(description ?? '').trim()
  if (!normalized) return 'Walk-in customer'

  const customerMatch = normalized.match(/\bto\s+(.+)$/i)
  if (customerMatch?.[1]) return customerMatch[1].trim()

  const locationMatch = normalized.match(/·\s*(.+)$/)
  if (locationMatch?.[1]) return locationMatch[1].trim()

  return 'Walk-in customer'
}

function extractPaymentItemLabel(description: string) {
  const normalized = String(description ?? '').trim()
  if (!normalized) return 'Payment recorded'

  const withoutPrefixes = normalized
    .replace(/^DishSale:\s*/i, '')
    .replace(/^Sale of\s*/i, '')

  const [beforeLocation] = withoutPrefixes.split('·')
  const withoutCustomer = beforeLocation.replace(/\s+to\s+.+$/i, '').replace(/\s*\[[^\]]+\]/g, '').trim()

  return withoutCustomer || normalized
}

function buildPaymentMethodEvents(txs: any[]): PaymentMethodEvent[] {
  const groups = new Map<string, any[]>()

  txs.forEach((tx) => {
    const key = String(tx.pairId ?? tx.id ?? `${tx.date ?? tx.createdAt ?? 'payment'}-${tx.amount ?? 0}`)
    const existing = groups.get(key)
    if (existing) {
      existing.push(tx)
      return
    }
    groups.set(key, [tx])
  })

  const events: PaymentMethodEvent[] = []

  groups.forEach((rows, groupKey) => {
    const isCollectedSale = rows.some((row) => isIncomeTransaction(row) && row.type === 'credit')
    if (!isCollectedSale) return

    const orderedRows = [...rows].sort((left, right) => getTransactionTimestamp(right) - getTransactionTimestamp(left))
    const representative = orderedRows[0]
    const description = String(representative.description ?? '').trim() || 'Payment recorded'

    events.push({
      key: groupKey,
      pairId: representative.pairId ?? null,
      date: representative.date ?? representative.createdAt ?? '',
      createdAt: representative.createdAt ?? null,
      paymentMethod: normalizePaymentMethodName(representative.paymentMethod),
      amount: Number(representative.amount ?? 0),
      description,
      clientLabel: extractPaymentClientLabel(description),
      itemLabel: extractPaymentItemLabel(description),
    })
  })

  return events.sort((left, right) => getTransactionTimestamp(right) - getTransactionTimestamp(left))
}

function buildPaymentMethodSummaries(txs: any[]) {
  const events = buildPaymentMethodEvents(txs)
  const grouped = new Map<string, PaymentMethodSummary>()

  events.forEach((event) => {
    const key = event.paymentMethod.toLowerCase()
    const existing = grouped.get(key)

    if (!existing) {
      grouped.set(key, {
        key,
        label: event.paymentMethod,
        buttonLabel: paymentMethodButtonLabel(event.paymentMethod),
        totalAmount: event.amount,
        count: 1,
        events: [event],
      })
      return
    }

    existing.totalAmount += event.amount
    existing.count += 1
    existing.events.push(event)
  })

  const methods = [...grouped.values()].sort((left, right) => {
    const leftOrder = PAYMENT_METHOD_SORT_ORDER[left.label] ?? 50
    const rightOrder = PAYMENT_METHOD_SORT_ORDER[right.label] ?? 50
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    if (left.totalAmount !== right.totalAmount) return right.totalAmount - left.totalAmount
    return left.label.localeCompare(right.label)
  })

  return {
    events,
    methods,
    totalAmount: events.reduce((sum, event) => sum + event.amount, 0),
    totalCount: events.length,
  }
}

function buildHistoryDateRows(activeTab: ReportTab, txs: any[] | null) {
  if (activeTab !== 'payment_methods') return txs ?? []

  return buildPaymentMethodEvents(txs ?? []).map((event) => ({
    key: event.key,
    date: event.date || event.createdAt || '',
  }))
}

function getTransactionFlow(tx: any): 'in' | 'out' {
  if (tx.direction === 'in' || tx.direction === 'out') return tx.direction
  return tx.type === 'credit' ? 'in' : 'out'
}

function usesCashSettlement(tx: any) {
  return isCashEquivalentAccountName(tx.paymentMethod)
}

//  SHARED TABLE COMPONENT 

function DataTable({ head, rows, foot }: { head: string[]; rows: (string|number)[][]; foot?: (string|number)[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-orange-500 text-white">
            {head.map((h,i) => (
              <th key={i} className={`px-3 py-2.5 text-xs font-bold uppercase tracking-wide whitespace-nowrap ${i===0?'text-left':'text-right'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length===0 ? (
            <tr><td colSpan={head.length} className="px-3 py-6 text-center text-sm text-gray-400 italic">No records found for this period.</td></tr>
          ) : rows.map((row,ri) => (
            <tr key={ri} className={ri%2===0?'bg-white':'bg-orange-50/40'}>
              {row.map((cell,ci) => (
                <td key={ci} className={`px-3 py-2 text-xs border-b border-gray-100 ${ci===0?'text-left text-gray-700':'text-right text-gray-600'}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot>
            <tr className="bg-gray-900 text-white font-bold">
              {foot.map((cell,ci) => (
                <td key={ci} className={`px-3 py-2.5 text-xs ${ci===0?'text-left':'text-right'}`}>{cell}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mt-5 mb-2 first:mt-0">
      <div className="h-3 w-1 rounded-full bg-orange-500"/>
      <h4 className="text-xs font-bold text-gray-600 uppercase tracking-widest">{children}</h4>
    </div>
  )
}

function StatCard({ label, value, color }: { label:string; value:string; color?:string }) {
  return (
    <div className={`rounded-xl border p-3 ${color??'bg-gray-50 border-gray-200'}`}>
      <p className="text-xs text-gray-500 mb-0.5">{label}</p>
      <p className="text-sm font-bold text-gray-900">{value}</p>
    </div>
  )
}

//  PER-TAB REPORT TABLES 

function JournalTable({ txs }: { txs: any[] }) {
  const dr = txs.filter(t=>t.type==='debit').reduce((s,t)=>s+t.amount,0)
  const cr = txs.filter(t=>t.type==='credit').reduce((s,t)=>s+t.amount,0)
  return (
    <>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="Entries" value={txs.length.toString()} />
        <StatCard label="Total Debits" value={`${fmt(dr)} RWF`} color="bg-orange-50 border-orange-200" />
        <StatCard label="Total Credits" value={`${fmt(cr)} RWF`} color="bg-green-50 border-green-200" />
      </div>
      <DataTable
        head={['Date','Account','Description','Type','Debit (RWF)','Credit (RWF)']}
        rows={txs.map(t=>[t.date?.slice(0,10)??'', t.account?.name??'', fmtDesc(t.description).slice(0,48), t.type?.toUpperCase(), t.type==='debit'?fmt(t.amount):'', t.type==='credit'?fmt(t.amount):''])}
        foot={['','','','TOTALS',fmt(dr),fmt(cr)]}
      />
    </>
  )
}

function ReceivableTable({ txs }: { txs: any[] }) {
  const ar = txs.filter(isReceivableTransaction)
  const total = ar.reduce((s,t)=>s+getReceivableEffect(t),0)
  return (
    <>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <StatCard label="A/R Transactions" value={ar.length.toString()} />
        <StatCard label="Total Receivables" value={`${fmt(total)} RWF`} color="bg-orange-50 border-orange-200" />
      </div>
      <DataTable
        head={['Date','Customer / Description','Account','Effect (RWF)']}
        rows={ar.map(t=>[t.date?.slice(0,10)??'',fmtDesc(t.description).slice(0,54),t.account?.name??'',`${getReceivableEffect(t)>=0?'+':'-'}${fmt(Math.abs(getReceivableEffect(t)))}`])}
        foot={ar.length>0?['','','TOTAL RECEIVABLE',fmt(total)]:undefined}
      />
    </>
  )
}

function PayableTable({ txs }: { txs: any[] }) {
  const ap = txs.filter(isPayableTransaction)
  const total = ap.reduce((s,t)=>s+getPayableEffect(t),0)
  return (
    <>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <StatCard label="A/P Transactions" value={ap.length.toString()} />
        <StatCard label="Total Payables" value={`${fmt(total)} RWF`} color="bg-red-50 border-red-200" />
      </div>
      <DataTable
        head={['Date','Supplier / Description','Account','Category','Effect (RWF)']}
        rows={ap.map(t=>[t.date?.slice(0,10)??'',fmtDesc(t.description).slice(0,42),t.account?.name??'',t.account?.category?.type??'',`${getPayableEffect(t)>=0?'+':'-'}${fmt(Math.abs(getPayableEffect(t)))}`])}
        foot={ap.length>0?['','','','TOTAL PAYABLE',fmt(total)]:undefined}
      />
    </>
  )
}

function CashFlowTable({ txs }: { txs: any[] }) {
  const cash = txs.filter(usesCashSettlement)
  const inflow  = cash.filter(t=>getTransactionFlow(t)==='in').reduce((s,t)=>s+t.amount,0)
  const outflow = cash.filter(t=>getTransactionFlow(t)==='out').reduce((s,t)=>s+t.amount,0)
  const net = inflow-outflow
  return (
    <>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="Cash Inflows" value={`${fmt(inflow)} RWF`} color="bg-green-50 border-green-200" />
        <StatCard label="Cash Outflows" value={`${fmt(outflow)} RWF`} color="bg-red-50 border-red-200" />
        <StatCard label="Net Cash" value={`${net>=0?'+':''}${fmt(net)} RWF`} color={net>=0?'bg-green-100 border-green-300':'bg-red-100 border-red-300'} />
      </div>
      <SectionTitle>Cash Summary</SectionTitle>
      <DataTable
        head={['Description','Amount (RWF)']}
        rows={[['Total Cash Inflows (Receipts)',fmt(inflow)],['Total Cash Outflows (Payments)',fmt(outflow)],['Net Cash Movement',fmt(net)]]}
      />
      {cash.length>0&&(
        <>
          <SectionTitle>Transaction Detail</SectionTitle>
          <DataTable
            head={['Date','Description','Flow','Amount (RWF)']}
            rows={cash.map(t=>[t.date?.slice(0,10)??'',fmtDesc(t.description).slice(0,50),getTransactionFlow(t)==='in'?'Inflow ':'Outflow ',fmt(t.amount)])}
          />
        </>
      )}
    </>
  )
}

function BalanceSheetTable({ txs }: { txs: any[] }) {
  const map = new Map<string,{dr:number;cr:number;cat:string}>()
  txs.forEach(t=>{
    const n=t.account?.name??'Unknown', c=t.account?.category?.type??''
    const p=map.get(n)??{dr:0,cr:0,cat:c}
    if(t.type==='debit')p.dr+=t.amount;else p.cr+=t.amount
    map.set(n,p)
  })
  const rows=[...map.entries()].map(([n,{dr,cr,cat}])=>({n,cat,dr,cr,net:dr-cr})).sort((a,b)=>a.cat.localeCompare(b.cat))
  const tDr=rows.reduce((s,r)=>s+r.dr,0), tCr=rows.reduce((s,r)=>s+r.cr,0)
  return (
    <>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="Accounts" value={rows.length.toString()} />
        <StatCard label="Total Debits" value={`${fmt(tDr)} RWF`} color="bg-orange-50 border-orange-200" />
        <StatCard label="Total Credits" value={`${fmt(tCr)} RWF`} color="bg-green-50 border-green-200" />
      </div>
      <DataTable
        head={['Account','Category','Debit (RWF)','Credit (RWF)','Net Balance']}
        rows={rows.map(r=>[r.n,r.cat,fmt(r.dr),fmt(r.cr),(r.net>=0?'DR ':'CR ')+fmt(Math.abs(r.net))])}
        foot={['','TOTALS',fmt(tDr),fmt(tCr),'']}
      />
    </>
  )
}

function IncomeTable({ txs }: { txs: any[] }) {
  const rev=txs.filter(isIncomeTransaction)
  const exp=txs.filter(isExpenseTransaction)
  const tRev=rev.reduce((s,t)=>s+getIncomeEffect(t),0), tExp=exp.reduce((s,t)=>s+getExpenseEffect(t),0), net=tRev-tExp
  return (
    <>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="Total Revenue" value={`${fmt(tRev)} RWF`} color="bg-green-50 border-green-200" />
        <StatCard label="Total Expenses" value={`${fmt(tExp)} RWF`} color="bg-red-50 border-red-200" />
        <StatCard label="Net Profit / (Loss)" value={`${net>=0?'+':''}${fmt(net)} RWF`} color={net>=0?'bg-green-100 border-green-300':'bg-red-100 border-red-300'} />
      </div>
      <SectionTitle>P&L Summary</SectionTitle>
      <DataTable
        head={['Line Item','Amount (RWF)']}
        rows={[['Total Revenue',fmt(tRev)],['Total Expenses',fmt(tExp)],['Net Profit / (Loss)',(net<0?'(':'')+fmt(Math.abs(net))+(net<0?')':'')]]}
      />
      {rev.length>0&&(
        <>
          <SectionTitle>Revenue Detail</SectionTitle>
          <DataTable head={['Date','Account','Description','Effect (RWF)']} rows={rev.map(t=>[t.date?.slice(0,10)??'',t.account?.name??'',fmtDesc(t.description).slice(0,44),`${getIncomeEffect(t)>=0?'+':'-'}${fmt(Math.abs(getIncomeEffect(t)))}`])} foot={['','','TOTAL REVENUE',fmt(tRev)]} />
        </>
      )}
      {exp.length>0&&(
        <>
          <SectionTitle>Expense Detail</SectionTitle>
          <DataTable head={['Date','Account','Description','Effect (RWF)']} rows={exp.map(t=>[t.date?.slice(0,10)??'',t.account?.name??'',fmtDesc(t.description).slice(0,44),`${getExpenseEffect(t)>=0?'+':'-'}${fmt(Math.abs(getExpenseEffect(t)))}`])} foot={['','','TOTAL EXPENSES',fmt(tExp)]} />
        </>
      )}
    </>
  )
}

function PaymentHistoryTable({ events }: { events: PaymentMethodEvent[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-y border-gray-200 bg-white text-gray-500">
            <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap">Date / Time</th>
            <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap">Client</th>
            <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide">Payment History</th>
            <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wide whitespace-nowrap">Amount</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, index) => (
            <tr key={event.key} className={index % 2 === 0 ? 'bg-white' : 'bg-white'}>
              <td className="px-4 py-5 text-xs text-gray-500 whitespace-nowrap border-t border-gray-100">{formatReportDateTime(event.date || event.createdAt)}</td>
              <td className="px-4 py-5 text-sm font-semibold text-gray-900 whitespace-nowrap border-t border-gray-100">{event.clientLabel}</td>
              <td className="px-4 py-5 border-t border-gray-100">
                <p className="text-sm font-semibold text-gray-900">{event.itemLabel}</p>
                <p className="mt-1 text-xs text-gray-500">{fmtDesc(event.description)}</p>
              </td>
              <td className="px-4 py-5 text-right text-sm font-semibold text-gray-900 whitespace-nowrap border-t border-gray-100">{fmt(event.amount)} RWF</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PaymentSummaryCard({
  label,
  value,
  emphasized = false,
}: {
  label: string
  value: string
  emphasized?: boolean
}) {
  return (
    <div className={`rounded-xl border px-5 py-4 ${emphasized ? 'border-blue-200 bg-blue-50/70' : 'border-gray-200 bg-white'}`}>
      <p className={`text-sm font-semibold ${emphasized ? 'text-blue-600' : 'text-gray-700'}`}>{label}</p>
      <p className="mt-3 text-[2rem] font-semibold leading-none text-gray-900">{value}</p>
    </div>
  )
}

function PaymentMethodsTable({ txs }: { txs: any[] }) {
  const { methods, totalAmount, totalCount } = buildPaymentMethodSummaries(txs)
  const [selectedMethodKey, setSelectedMethodKey] = useState('')

  useEffect(() => {
    if (methods.length === 0) {
      if (selectedMethodKey) setSelectedMethodKey('')
      return
    }

    if (!methods.some((method) => method.key === selectedMethodKey)) {
      setSelectedMethodKey(methods[0].key)
    }
  }, [methods, selectedMethodKey])

  const activeMethod = methods.find((method) => method.key === selectedMethodKey) ?? methods[0] ?? null

  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 mb-6">
        <PaymentSummaryCard label="Total Collected" value={`${fmt(totalAmount)} RWF`} emphasized />
        <PaymentSummaryCard label="Methods Used" value={methods.length.toString()} />
        <PaymentSummaryCard label="Recorded Sales" value={totalCount.toString()} />
      </div>

      {methods.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-10 text-center text-sm text-gray-500">
          No collected sales were found for this period.
        </div>
      ) : (
        <>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {methods.map((method) => {
              const isActive = method.key === activeMethod?.key

              return (
                <button
                  key={method.key}
                  onClick={() => setSelectedMethodKey(method.key)}
                  className={`min-w-[102px] rounded-lg border px-4 py-4 text-left transition-all ${
                    isActive
                      ? 'border-blue-300 bg-blue-50 shadow-sm'
                      : 'border-gray-200 bg-white hover:bg-gray-50'
                  }`}
                >
                  <p className={`text-sm font-semibold ${isActive ? 'text-blue-700' : 'text-gray-900'}`}>{method.buttonLabel}</p>
                  <p className={`mt-1 text-xs ${isActive ? 'text-blue-600' : 'text-gray-500'}`}>{method.count} {method.count === 1 ? 'sale' : 'sales'}</p>
                  <p className={`mt-3 text-[1.35rem] font-semibold leading-none ${isActive ? 'text-blue-700' : 'text-gray-900'}`}>{fmt(method.totalAmount)} RWF</p>
                </button>
              )
            })}
          </div>

          {activeMethod && (
            <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-5 py-5">
                <h4 className="text-[1.85rem] font-semibold leading-none text-gray-900">{activeMethod.buttonLabel} History</h4>
                <p className="mt-2 text-sm text-gray-500">{activeMethod.count} {activeMethod.count === 1 ? 'sale' : 'sales'} recorded with {activeMethod.buttonLabel}.</p>
              </div>
              <PaymentHistoryTable events={activeMethod.events} />
            </div>
          )}
        </>
      )}
    </>
  )
}

function DishProfitTable({ data }: { data: any }) {
  if (!data) return <div className="py-10 text-center text-gray-400 text-sm">Loading orders report data…</div>
  const dishes: any[] = data.orders ?? data.dishes ?? []
  const totals: any = data.totals ?? {}
  return (
    <>
      <div className="grid grid-cols-4 gap-3 mb-4">
        <StatCard label="Orders Tracked" value={dishes.length.toString()} />
        <StatCard label="Total Revenue" value={`${fmt(totals.totalRevenue ?? 0)} RWF`} color="bg-green-50 border-green-200" />
        <StatCard label="Total Cost" value={`${fmt(totals.totalCost ?? 0)} RWF`} color="bg-red-50 border-red-200" />
        <StatCard label="Total Profit" value={`${totals.totalProfit >= 0 ? '+' : ''}${fmt(totals.totalProfit ?? 0)} RWF`}
          color={(totals.totalProfit ?? 0) >= 0 ? 'bg-green-100 border-green-300' : 'bg-red-100 border-red-300'} />
      </div>
      {dishes.length === 0 ? (
        <div className="py-8 text-center text-gray-400 text-sm">No orders found for this period.</div>
      ) : (
        <DataTable
          head={['Order', 'Waiter', 'Status', 'Qty Sold', 'Cost', 'Price', 'Total Price', 'Profit']}
          rows={dishes.map((d:any) => [
            d.orderLabel ?? d.dishName,
            d.waiterName ?? 'Unknown',
            statusLabel(d.status),
            d.qtySold,
            fmt(d.totalCost),
            fmt(d.unitPrice),
            fmt(d.totalPrice ?? d.totalRevenue),
            (d.totalProfit >= 0 ? '' : '-') + fmt(Math.abs(d.totalProfit)),
          ])}
          foot={['TOTALS', '', '', totals.totalQtySold ?? '', fmt(totals.totalCost ?? 0), '', fmt(totals.totalPrice ?? totals.totalRevenue ?? 0), fmt(totals.totalProfit ?? 0)]}
        />
      )}
      {dishes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3 text-sm font-semibold text-gray-700">
          <span>Total Revenue: <span className="text-green-700">{fmt(totals.totalRevenue ?? 0)} RWF</span></span>
          <span>Total Profit: <span className={(totals.totalProfit ?? 0) >= 0 ? 'text-green-700' : 'text-red-700'}>{fmt(totals.totalProfit ?? 0)} RWF</span></span>
        </div>
      )}
    </>
  )
}

function BranchSummaryTable({ data, onExportPdf, onSharePdf, exporting }: {
  data: { rows: BranchSummaryRow[]; totals: { totalSales: number; totalCost: number; totalProfit: number } } | null
  onExportPdf: () => void
  onSharePdf: () => void
  exporting: boolean
}) {
  if (!data) return <div className="py-10 text-center text-gray-400 text-sm">Loading general report…</div>
  const rows = data.rows ?? []
  const totals = data.totals ?? { totalSales: 0, totalCost: 0, totalProfit: 0 }
  const overallMargin = totals.totalSales > 0 ? Math.round((totals.totalProfit / totals.totalSales) * 1000) / 10 : 0
  return (
    <>
      <div className="flex items-center justify-end gap-2 mb-4">
        <button onClick={onSharePdf} disabled={exporting}
          className="flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 text-gray-700 text-xs font-semibold px-3 py-1.5 rounded-lg shadow-sm transition-colors">
          <Share2 className="h-3.5 w-3.5"/> Share PDF
        </button>
        <button onClick={onExportPdf} disabled={exporting}
          className="flex items-center gap-1.5 bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg shadow-sm transition-colors">
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : <Download className="h-3.5 w-3.5"/>} Export PDF
        </button>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="Gross Sales" value={`${fmt(totals.totalSales)} RWF`} color="bg-green-50 border-green-200" />
        <StatCard label="Cost of Goods Sold" value={`${fmt(totals.totalCost)} RWF`} color="bg-red-50 border-red-200" />
        <StatCard label="Net Profit / Loss" value={`${totals.totalProfit >= 0 ? '+' : '-'}${fmt(Math.abs(totals.totalProfit))} RWF`}
          color={totals.totalProfit >= 0 ? 'bg-green-100 border-green-300' : 'bg-red-100 border-red-300'} />
      </div>
      {rows.length === 0 ? (
        <div className="py-8 text-center text-gray-400 text-sm">No sales found for this period.</div>
      ) : (
        <DataTable
          head={['Station', 'Sales Amount (RWF)', '% of Sales', 'Cost of Goods (RWF)', 'Profit / Loss (RWF)', 'Margin %']}
          rows={rows.map((r) => [
            r.branchName,
            fmt(r.sales),
            `${r.percentOfSales.toFixed(1)}%`,
            fmt(r.cost),
            `${r.profit >= 0 ? '' : '-'}${fmt(Math.abs(r.profit))}`,
            `${r.marginPercent.toFixed(1)}%`,
          ])}
          foot={['GROSS TOTAL', fmt(totals.totalSales), '100.0%', fmt(totals.totalCost), `${totals.totalProfit >= 0 ? '' : '-'}${fmt(Math.abs(totals.totalProfit))}`, `${overallMargin.toFixed(1)}%`]}
        />
      )}
      <p className="mt-3 text-xs text-gray-400">Refunds, if any, are not reflected in this report.</p>
    </>
  )
}

const CONFIDENCE_STYLES: Record<'high'|'medium'|'low', { dot: string; label: string; text: string }> = {
  high:   { dot: 'bg-green-500',  label: 'High',   text: 'text-gray-700' },
  medium: { dot: 'bg-amber-500',  label: 'Medium', text: 'text-gray-600' },
  low:    { dot: 'bg-gray-300 border border-gray-400', label: 'Low', text: 'text-gray-400' },
}

function ConfidenceChip({ level }: { level: 'high'|'medium'|'low' }) {
  const s = CONFIDENCE_STYLES[level]
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${s.dot}`} />
      {s.label}
    </span>
  )
}

function UpsellingTable({ data }: { data: UpsellingData | null }) {
  if (!data) return <div className="py-10 text-center text-gray-400 text-sm">Loading upsell report…</div>
  const rows = data.rows ?? []
  const house = data.house
  const pairings = data.pairings ?? []
  const opportunities = data.opportunities ?? []
  const summary = data.summary
  const meta = data.meta
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`)

  if (!house || house.checks === 0) {
    return <div className="py-8 text-center text-gray-400 text-sm">No paid orders found for this period.</div>
  }

  return (
    <>
      {/* Scope — without it the numbers have no context */}
      <p className="text-xs text-gray-500 mb-3">
        All stations · <span className="font-semibold text-gray-700">{fmt(meta.serverChecks)} eligible bills</span>
        {meta.selfOrderChecks > 0 && <> · {fmt(meta.selfOrderChecks)} guest QR bills excluded</>}
      </p>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="Upsell Gross Profit" value={`${fmt(summary.upsellProfit)} RWF`} color="bg-green-50 border-green-200" />
        <StatCard label="Profit per Bill" value={`${fmt(summary.profitPerBill)} RWF`} />
        <StatCard label="Profit Opportunity" value={`${fmt(summary.opportunity)} RWF`} color="bg-amber-50 border-amber-200" />
      </div>

      {/* One sentence so an owner can stop reading here */}
      <div className="rounded-xl border border-gray-200 border-l-[3px] border-l-orange-500 bg-white px-4 py-3 mb-5">
        <p className="text-[10px] font-bold uppercase tracking-wider text-orange-600 mb-1">Jesse&apos;s take</p>
        <p className="text-sm text-gray-700 leading-relaxed">
          Upselling generated <span className="font-bold text-gray-900">{fmt(summary.upsellProfit)} RWF</span> of gross profit
          at a <span className="font-bold text-gray-900">{summary.upsellMargin.toFixed(0)}%</span> margin.
          {summary.topServerName && (
            <> <span className="font-bold text-gray-900">{summary.topServerName}</span> leads the floor at{' '}
              <span className="font-bold text-gray-900">{pct(summary.topServerRate)}</span> attachment.</>
          )}
          {opportunities.length > 0 && (
            <> The largest single gap is <span className="font-bold text-gray-900">{opportunities[0].baseName} + {opportunities[0].attachName}</span>,
              worth about <span className="font-bold text-gray-900">{fmt(opportunities[0].missedProfit)} RWF</span>.</>
          )}
        </p>
      </div>

      {opportunities.length > 0 && (
        <div className="mb-5">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">Top opportunities</h4>
          <div className="rounded-xl border border-gray-200 bg-white px-4">
            {opportunities.slice(0, 3).map((o, i) => (
              <div key={o.key} className={`flex items-center justify-between gap-5 py-3.5 ${i > 0 ? 'border-t border-gray-100' : ''}`}>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">
                    {o.baseName} <span className="font-normal text-gray-400">+</span> {o.attachName}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Sold together on <span className="font-semibold text-gray-700">{o.together} of {o.baseBills}</span> bills — <span className="font-semibold text-gray-700">{o.houseRate.toFixed(0)}%</span>.
                    {' '}{o.bestServerName} reaches <span className="font-semibold text-gray-700">{o.bestServerRate.toFixed(0)}%</span>.
                  </p>
                  <div className="mt-2 h-1.5 max-w-[320px] rounded-full bg-gray-100 overflow-hidden flex">
                    <span className="h-full bg-orange-500" style={{ width: `${Math.min(100, o.houseRate)}%` }} />
                    <span className="h-full bg-amber-300" style={{ width: `${Math.min(100 - Math.min(100, o.houseRate), o.gapPoints)}%` }} />
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-lg font-bold text-amber-600 leading-tight">{fmt(o.missedProfit)}</p>
                  <p className="text-[10px] uppercase tracking-wider text-gray-400">RWF</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {pairings.length > 0 && (
        <div className="mb-5">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">What sells together</h4>
          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-orange-500 text-white">
                  {['Pairing', 'Sold together', 'Gross profit (RWF)', 'Margin', 'Confidence'].map((h, i) => (
                    <th key={h} className={`px-3 py-2.5 text-xs font-bold uppercase tracking-wide whitespace-nowrap ${i === 0 || i === 4 ? 'text-left' : 'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pairings.slice(0, 8).map((p, i) => (
                  <tr key={p.key} className={`${i % 2 === 0 ? 'bg-white' : 'bg-orange-50/40'} ${p.confidence === 'low' ? 'text-gray-400' : ''}`}>
                    <td className="px-3 py-2 text-xs border-b border-gray-100 text-gray-700 whitespace-nowrap">
                      <span className="font-semibold">{p.baseName}</span>
                      <span className="text-gray-400 mx-1.5">+</span>
                      <span className="font-semibold text-orange-600">{p.attachName}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-right border-b border-gray-100 tabular-nums">{p.together} of {p.baseBills} · {p.attachRate.toFixed(0)}%</td>
                    <td className="px-3 py-2 text-xs text-right border-b border-gray-100 font-bold text-green-700 tabular-nums">{fmt(p.profit)}</td>
                    <td className="px-3 py-2 text-xs text-right border-b border-gray-100 tabular-nums">{p.margin.toFixed(0)}%</td>
                    <td className="px-3 py-2 text-xs text-left border-b border-gray-100"><ConfidenceChip level={p.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            Ranked by gross profit, not revenue — a cheap side often out-earns a premium main once food cost is taken off.
            {meta.pairingsTotal > pairings.slice(0, 8).length && <> Showing 8 of {meta.pairingsTotal} pairings.</>}
          </p>
        </div>
      )}

      <div className="mb-5">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">Who sells it</h4>
        <DataTable
          head={['Waiter', 'Bills', 'Attach rate', 'Profit / bill (RWF)', 'vs house']}
          rows={rows.slice(0, 10).map((r) => [
            r.ranked ? r.serverName : `${r.serverName} · ${r.checks} bills`,
            r.checks,
            pct(r.addonRate),
            fmt(r.profitPerCheck),
            r.vsHouse === null
              ? 'Insufficient volume'
              : `${r.vsHouse >= 0 ? '▲ ' : '▼ '}${fmt(Math.abs(r.vsHouse))}`,
          ])}
          foot={['HOUSE', house.checks, pct(house.addonRate), fmt(house.profitPerCheck), '']}
        />
        <p className="mt-2 text-xs text-gray-400">
          Ranked by profit per bill, so a waiter working more tables doesn&apos;t automatically look better.
          Under 20 bills shows no comparison.
        </p>
      </div>

      <details className="rounded-xl border border-gray-200 bg-white">
        <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-gray-600 select-none">
          About this report
        </summary>
        <div className="px-4 pb-4 space-y-2 text-xs text-gray-500 leading-relaxed">
          <p>
            <span className="font-semibold text-gray-700">Attachment, not conversion.</span> Attachment rate measures how
            often two items appear on the same bill. It does not prove a waiter offered the second item — nothing records
            an offer that was declined, so a 0% rate may mean a waiter never asks, or that their tables never want one.
          </p>
          <p>
            <span className="font-semibold text-gray-700">What counts.</span> Add-ons, sides and desserts, plus drinks.
            Drinks are measured only against bills that had food on them: a guest who came in for two beers was not
            upsold a drink, that was the visit.
          </p>
          <p>
            <span className="font-semibold text-gray-700">Benchmarks come from your own floor.</span> Profit opportunity
            compares each pairing against the waiter who already achieves the best rate on it here, over at least 5 bills.
            No industry targets are assumed. The headline covers the top 3 shown, not every pairing.
          </p>
          <p>
            <span className="font-semibold text-gray-700">Scope.</span> Whole restaurant account, every station — one bill
            routinely spans stations and it is the bill that gets upsold. Waiters are identified by the name they ring up
            under, not the terminal screen&apos;s shared account. Guest QR orders are excluded.
          </p>
          {meta.uncostedAttachLines > 0 && (
            <p className="text-amber-600">{fmt(meta.uncostedAttachLines)} attached lines have no recorded food cost, so their profit is overstated.</p>
          )}
          {meta.uncategorizedItems > 0 && (
            <p>{fmt(meta.uncategorizedItems)} sold items have no menu category and are excluded from attach rates.</p>
          )}
          {meta.coveredChecks === 0 && <p>Guest counts are not being recorded yet, so per-cover figures are unavailable.</p>}
        </div>
      </details>
    </>
  )
}

function InventoryMovementTable({ data }: { data: any }) {
  if (!data) return <div className="py-10 text-center text-gray-400 text-sm">Loading inventory movement data…</div>
  const items: any[] = data.items ?? []
  const totals: any = data.totals ?? {}
  return (
    <>
      <div className="grid grid-cols-4 gap-3 mb-4">
        <StatCard label="Ingredients" value={items.length.toString()} />
        <StatCard label="Total Purchased" value={`${fmt(totals.totalPurchaseCost ?? 0)} RWF`} color="bg-orange-50 border-orange-200" />
        <StatCard label="Total Used (Cost)" value={`${fmt(totals.totalUsedCost ?? 0)} RWF`} color="bg-red-50 border-red-200" />
        <StatCard label="Remaining Stock Value" value={`${fmt(totals.totalStockValue ?? 0)} RWF`} color="bg-green-50 border-green-200" />
      </div>
      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800 mb-4">
        Bought quantity and purchase cost only cover the selected date range. Opening stock shows what was already on hand before that range, while Remaining is the stock on hand at the end of the selected range.
      </div>
      {items.length === 0 ? (
        <div className="py-8 text-center text-gray-400 text-sm">No inventory movement found for this period.</div>
      ) : (
        <DataTable
          head={['Ingredient', 'Unit', 'Opening', 'Bought Qty', 'Purchase Cost', 'Used Qty', 'Used Cost', 'Remaining', 'Stock Value', 'Status']}
          rows={items.map((i:any) => [
            i.ingredientName, i.unit,
            i.openingQty,
            i.purchasedQty, fmt(i.purchaseCost),
            i.usedQty, fmt(i.usedCost),
            i.remainingQty, fmt(i.stockValue),
            i.isLow ? 'Low Stock' : 'OK',
          ])}
          foot={['TOTALS', '', '', '', fmt(totals.totalPurchaseCost ?? 0), '', fmt(totals.totalUsedCost ?? 0), '', fmt(totals.totalStockValue ?? 0), '']}
        />
      )}
    </>
  )
}

function TheoreticalInventoryTable({ data, onCountSaved }: { data: any; onCountSaved?: () => void }) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftQty, setDraftQty] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId && inputRef.current) inputRef.current.focus()
  }, [editingId])

  const saveCount = async (ingredientId: string) => {
    const qty = parseFloat(draftQty)
    if (!Number.isFinite(qty) || qty < 0) { setEditingId(null); return }
    setSaving(true)
    try {
      const res = await fetch('/api/restaurant/stock-take', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ingredientId, quantity: qty }),
      })
      if (res.ok) onCountSaved?.()
    } finally {
      setSaving(false)
      setEditingId(null)
    }
  }

  if (!data) return <div className="py-10 text-center text-gray-400 text-sm">Loading theoretical inventory data…</div>
  const items: any[] = data.items ?? []
  const totals: any = data.totals ?? {}
  const noCountCount: number = totals.noCountCount ?? items.length

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard label="Ingredients" value={items.length.toString()} />
        <StatCard label="Theoretical Usage Cost" value={`${fmt(totals.totalUsedCost ?? 0)} RWF`} color="bg-red-50 border-red-200" />
        <StatCard label="Waste Cost" value={`${fmt(totals.totalWasteCost ?? 0)} RWF`} color="bg-orange-50 border-orange-200" />
        <StatCard label="Variance Cost" value={`${fmt(totals.totalVarianceCost ?? 0)} RWF`} color="bg-amber-50 border-amber-200" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard label="Counted Items" value={`${totals.countedCount ?? 0} / ${items.length}`} color="bg-green-50 border-green-200" />
        <StatCard label="Variance Items" value={(totals.varianceCount ?? 0).toString()} color="bg-amber-50 border-amber-200" />
        <StatCard label="Theoretical Stock Value" value={`${fmt(totals.totalTheoreticalStockValue ?? 0)} RWF`} color="bg-blue-50 border-blue-200" />
        <StatCard label="Actual Stock Value" value={totals.countedCount > 0 ? `${fmt(totals.totalActualStockValue ?? 0)} RWF` : '—'} color="bg-green-50 border-green-200" />
      </div>
      {noCountCount > 0 && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800 mb-4">
          <strong>{noCountCount} ingredient{noCountCount !== 1 ? 's' : ''} not yet counted.</strong> Click the <strong>Actual</strong> cell for any ingredient to enter your physical count. Variance calculates automatically.
        </div>
      )}
      {items.length === 0 ? (
        <div className="py-8 text-center text-gray-400 text-sm">No theoretical inventory data found for this period.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                {['Ingredient', 'Unit', 'Opening', 'Bought', 'Used', 'Waste', 'Theoretical', 'Actual ✎', 'Variance', 'Variance Cost', 'Status'].map(h => (
                  <th key={h} className="px-3 py-2 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((i: any) => {
                const isEditing = editingId === i.id
                const statusColor = i.varianceStatus === 'Matched' ? 'text-green-700 bg-green-50' :
                  i.varianceStatus === 'No Count' ? 'text-gray-500 bg-gray-50' :
                  i.varianceStatus === 'Over' ? 'text-blue-700 bg-blue-50' : 'text-red-700 bg-red-50'
                return (
                  <tr key={i.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">{i.ingredientName}</td>
                    <td className="px-3 py-2 text-gray-500">{i.unit}</td>
                    <td className="px-3 py-2 text-gray-700">{i.openingQty}</td>
                    <td className="px-3 py-2 text-gray-700">{i.purchasedQty}</td>
                    <td className="px-3 py-2 text-gray-700">{i.usedQty}</td>
                    <td className="px-3 py-2 text-gray-700">{i.wasteQty}</td>
                    <td className="px-3 py-2 font-semibold text-gray-900">{i.theoreticalQty}</td>
                    <td
                      className="px-3 py-2 cursor-pointer"
                      onClick={() => { if (!isEditing) { setEditingId(i.id); setDraftQty(i.actualQty != null ? String(i.actualQty) : '') } }}
                    >
                      {isEditing ? (
                        <div className="flex items-center gap-1">
                          <input
                            ref={inputRef}
                            type="number"
                            min="0"
                            step="any"
                            value={draftQty}
                            onChange={e => setDraftQty(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') void saveCount(i.id)
                              if (e.key === 'Escape') setEditingId(null)
                            }}
                            onBlur={() => void saveCount(i.id)}
                            className="w-20 rounded border border-orange-400 px-1.5 py-0.5 text-xs outline-none focus:ring-1 focus:ring-orange-300"
                            disabled={saving}
                          />
                        </div>
                      ) : i.actualQty != null ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-orange-50 border border-orange-200 px-2 py-0.5 text-orange-800 font-semibold hover:bg-orange-100 transition-colors">
                          {i.actualQty}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-gray-300 px-2 py-0.5 text-gray-400 hover:border-orange-400 hover:text-orange-500 transition-colors">
                          — Enter count
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-700">{i.varianceQty != null ? i.varianceQty : '—'}</td>
                    <td className="px-3 py-2 text-gray-700">{i.varianceCost != null ? fmt(i.varianceCost) : '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusColor}`}>
                        {i.varianceStatus}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold text-gray-700">
                <td className="px-3 py-2" colSpan={9}>TOTALS</td>
                <td className="px-3 py-2">{fmt(totals.totalVarianceCost ?? 0)}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{totals.varianceCount ?? 0} variance</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  )
}

//  BRANCH REPORT CACHE  (survives tab switches within the same page session)

type ReportSnapshot = {
  period: Period; rangeMode: 'preset' | 'custom'
  draftFrom: string; draftTo: string
  txData: any[]; periodTxData: any[]
  dishProfitData: any; invMovementData: any; theoreticalInvData: any
  loadedPeriod: string
}
const _branchReportCache = new Map<string, ReportSnapshot>()

//  MAIN COMPONENT

export default function RestaurantReports({ onAskJesse }: { onAskJesse?: () => void }) {
  const [activeTab, setActiveTab] = useState<ReportTab>('general')
  const [period, setPeriod] = useState<Period>('today')
  const today = todayStr()
  const [rangeMode, setRangeMode] = useState<'preset' | 'custom'>('preset')
  const [draftFrom, setDraftFrom] = useState(today)
  const [draftTo, setDraftTo] = useState(today)
  const [selectedHistoryDate, setSelectedHistoryDate] = useState(today)
  const [loading, setLoading] = useState(false)
  const [txData, setTxData] = useState<any[] | null>(null)
  // Keeps the full-period transaction list so date chips stay stable when a single day is selected
  const [periodTxData, setPeriodTxData] = useState<any[] | null>(null)
  const [dishProfitData, setDishProfitData] = useState<any>(null)
  const [invMovementData, setInvMovementData] = useState<any>(null)
  const [theoreticalInvData, setTheoreticalInvData] = useState<any>(null)
  const [branchSummaryData, setBranchSummaryData] = useState<{ rows: BranchSummaryRow[]; totals: { totalSales: number; totalCost: number; totalProfit: number } } | null>(null)
  const [branchSummaryExporting, setBranchSummaryExporting] = useState(false)
  const [upsellingData, setUpsellingData] = useState<UpsellingData | null>(null)
  const [loadedPeriod, setLoadedPeriod] = useState<string>('')
  const [exporting, setExporting] = useState(false)
  const branchCtx = useRestaurantBranch()
  const branchId = branchCtx?.branchId ?? ''
  const activeBranchRef = useRef(branchId)

  const isFirstMount = useRef(true)
  const autoSelectedPeriod = useRef<Period | null>(null)
  // General Report fetches independently of the auto period-detection below —
  // without this gate it fires immediately for the default 'today' period,
  // flashes "No sales found" for whichever period turns out to have no data,
  // then flashes again once auto-detection lands on the right period.
  const [initialPeriodReady, setInitialPeriodReady] = useState(false)

  const fetchReportRange = useCallback(async (
    start: string, end: string, label: string, isPeriodFetch = true,
    snapPeriod?: Period, snapRangeMode?: 'preset' | 'custom', snapFrom?: string, snapTo?: string,
  ) => {
    setLoading(true); setTxData(null); setDishProfitData(null); setInvMovementData(null); setTheoreticalInvData(null)
    try {
      const [txRes, dpRes, imRes, tiRes] = await Promise.all([
        fetch(`/api/transactions?startDate=${start}&endDate=${end}`, FRESH_FETCH_OPTIONS),
        fetch(`/api/restaurant/reports/dish-profitability?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
        fetch(`/api/restaurant/reports/inventory-movement?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
        fetch(`/api/restaurant/reports/theoretical-inventory?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
      ])
      let txRows: any[] = []
      if (txRes.ok) {
        const d = await txRes.json()
        txRows = normalizeTransactions(Array.isArray(d)?d:(d.transactions??d.data??[]))
        setTxData(txRows)
        if (isPeriodFetch) setPeriodTxData(txRows)
        setLoadedPeriod(label)
      }
      let dpData: any = null, imData: any = null, tiData: any = null
      if (dpRes.ok) { dpData = await dpRes.json(); setDishProfitData(dpData) }
      if (imRes.ok) { imData = await imRes.json(); setInvMovementData(imData) }
      if (tiRes.ok) { tiData = await tiRes.json(); setTheoreticalInvData(tiData) }
      if (activeBranchRef.current) {
        _branchReportCache.set(activeBranchRef.current, {
          period: snapPeriod ?? 'today', rangeMode: snapRangeMode ?? 'preset',
          draftFrom: snapFrom ?? start, draftTo: snapTo ?? end,
          txData: txRows, periodTxData: txRows,
          dishProfitData: dpData, invMovementData: imData, theoreticalInvData: tiData,
          loadedPeriod: label,
        })
      }
    } catch { setTxData([]) }
    finally { setLoading(false) }
  }, [])

  const fetchReport = useCallback(async (p: Period) => {
    const { start, end, label } = getDateRange(p)
    try { localStorage.setItem('magnify-reports-period', p) } catch { /* */ }
    await fetchReportRange(start, end, label, true, p, 'preset', start, end)
  }, [fetchReportRange])

  // On mount: use localStorage-cached period for instant load; background-load heavy reports after transactions
  useEffect(() => {
    async function loadInitial() {
      setLoading(true)
      const saved = (typeof localStorage !== 'undefined'
        ? localStorage.getItem('magnify-reports-period')
        : null) as Period | null
      const ordered: Period[] = saved
        ? [saved, ...(['today', 'week', 'month', 'quarter', 'year'] as Period[]).filter(p => p !== saved)]
        : ['today', 'week', 'month', 'quarter', 'year']

      for (let i = 0; i < ordered.length; i++) {
        const p = ordered[i]
        const { start, end, label } = getDateRange(p)
        try {
          const res = await fetch(`/api/transactions?startDate=${start}&endDate=${end}`, FRESH_FETCH_OPTIONS)
          if (!res.ok) continue
          const d = await res.json()
          const rows = normalizeTransactions(Array.isArray(d) ? d : (d.transactions ?? d.data ?? []))
          const isLast = i === ordered.length - 1
          if (rows.length > 0 || isLast) {
            autoSelectedPeriod.current = p
            setPeriod(p)
            setRangeMode('preset')
            setTxData(rows)
            setPeriodTxData(rows)
            setLoadedPeriod(label)
            setLoading(false)
            setInitialPeriodReady(true)
            if (rows.length > 0) {
              try { localStorage.setItem('magnify-reports-period', p) } catch { /* */ }
            }
            // Background-load heavy reports without blocking the UI
            Promise.all([
              fetch(`/api/restaurant/reports/dish-profitability?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
              fetch(`/api/restaurant/reports/inventory-movement?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
              fetch(`/api/restaurant/reports/theoretical-inventory?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
            ]).then(async ([dpRes, imRes, tiRes]) => {
              let dpData: any = null, imData: any = null, tiData: any = null
              if (dpRes.ok) { dpData = await dpRes.json(); setDishProfitData(dpData) }
              if (imRes.ok) { imData = await imRes.json(); setInvMovementData(imData) }
              if (tiRes.ok) { tiData = await tiRes.json(); setTheoreticalInvData(tiData) }
              if (activeBranchRef.current) {
                _branchReportCache.set(activeBranchRef.current, {
                  period: p, rangeMode: 'preset',
                  draftFrom: start, draftTo: end,
                  txData: rows, periodTxData: rows,
                  dishProfitData: dpData, invMovementData: imData, theoreticalInvData: tiData,
                  loadedPeriod: label,
                })
              }
            }).catch(() => { /* non-critical — tabs will show empty state */ })
            return
          }
        } catch { /* continue to next period */ }
      }
      setLoading(false)
      setInitialPeriodReady(true)
    }
    loadInitial()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch when period pill is clicked manually (skip initial mount and autoSelectPeriod-triggered changes)
  useEffect(() => {
    if (isFirstMount.current) { isFirstMount.current = false; return }
    if (period === autoSelectedPeriod.current) { autoSelectedPeriod.current = null; return }
    if (rangeMode === 'custom') {
      fetchReportRange(draftFrom, draftTo, `${draftFrom} - ${draftTo}`)
      return
    }
    fetchReport(period)
  }, [draftFrom, draftTo, period, rangeMode, fetchReport, fetchReportRange])

  // Auto-refresh when transactions are added/updated
  useEffect(() => {
    const handler = () => {
      if (rangeMode === 'custom') {
        fetchReportRange(draftFrom, draftTo, `${draftFrom} - ${draftTo}`)
        return
      }
      fetchReport(period)
    }
    window.addEventListener('refreshTransactions', handler)
    return () => window.removeEventListener('refreshTransactions', handler)
  }, [draftFrom, draftTo, period, rangeMode, fetchReport, fetchReportRange])

  // On branch switch: restore cache instantly, then silently refresh in background
  useEffect(() => {
    if (activeBranchRef.current === branchId) return // mount or same branch — skip
    activeBranchRef.current = branchId

    const cached = branchId ? _branchReportCache.get(branchId) : null
    if (cached) {
      autoSelectedPeriod.current = cached.period
      setPeriod(cached.period)
      setRangeMode(cached.rangeMode)
      setDraftFrom(cached.draftFrom)
      setDraftTo(cached.draftTo)
      setTxData(cached.txData)
      setPeriodTxData(cached.periodTxData)
      setDishProfitData(cached.dishProfitData)
      setInvMovementData(cached.invMovementData)
      setTheoreticalInvData(cached.theoreticalInvData)
      setLoadedPeriod(cached.loadedPeriod)
      // Silently re-fetch to keep data fresh
      const { start, end } = cached.rangeMode === 'custom'
        ? { start: cached.draftFrom, end: cached.draftTo }
        : getDateRange(cached.period)
      Promise.all([
        fetch(`/api/transactions?startDate=${start}&endDate=${end}`, FRESH_FETCH_OPTIONS),
        fetch(`/api/restaurant/reports/dish-profitability?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
        fetch(`/api/restaurant/reports/inventory-movement?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
        fetch(`/api/restaurant/reports/theoretical-inventory?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
      ]).then(async ([txRes, dpRes, imRes, tiRes]) => {
        let txRows = cached.txData
        if (txRes.ok) {
          const d = await txRes.json()
          txRows = normalizeTransactions(Array.isArray(d) ? d : (d.transactions ?? d.data ?? []))
          setTxData(txRows); setPeriodTxData(txRows)
        }
        let dpData = cached.dishProfitData, imData = cached.invMovementData, tiData = cached.theoreticalInvData
        if (dpRes.ok) { dpData = await dpRes.json(); setDishProfitData(dpData) }
        if (imRes.ok) { imData = await imRes.json(); setInvMovementData(imData) }
        if (tiRes.ok) { tiData = await tiRes.json(); setTheoreticalInvData(tiData) }
        _branchReportCache.set(branchId, { ...cached, txData: txRows, periodTxData: txRows, dishProfitData: dpData, invMovementData: imData, theoreticalInvData: tiData })
      }).catch(() => {})
    } else {
      // No cache yet for this branch — fresh load with loading indicator
      setLoading(true)
      setTxData(null); setDishProfitData(null); setInvMovementData(null); setTheoreticalInvData(null)
      const { start, end, label } = getDateRange(period)
      fetch(`/api/transactions?startDate=${start}&endDate=${end}`, FRESH_FETCH_OPTIONS)
        .then(async (res) => {
          if (!res.ok) return
          const d = await res.json()
          const rows = normalizeTransactions(Array.isArray(d) ? d : (d.transactions ?? d.data ?? []))
          setTxData(rows); setPeriodTxData(rows); setLoadedPeriod(label)
          Promise.all([
            fetch(`/api/restaurant/reports/dish-profitability?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
            fetch(`/api/restaurant/reports/inventory-movement?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
            fetch(`/api/restaurant/reports/theoretical-inventory?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
          ]).then(async ([dpRes, imRes, tiRes]) => {
            let dpData: any = null, imData: any = null, tiData: any = null
            if (dpRes.ok) { dpData = await dpRes.json(); setDishProfitData(dpData) }
            if (imRes.ok) { imData = await imRes.json(); setInvMovementData(imData) }
            if (tiRes.ok) { tiData = await tiRes.json(); setTheoreticalInvData(tiData) }
            _branchReportCache.set(branchId, {
              period, rangeMode: 'preset', draftFrom: start, draftTo: end,
              txData: rows, periodTxData: rows,
              dishProfitData: dpData, invMovementData: imData, theoreticalInvData: tiData,
              loadedPeriod: label,
            })
          }).catch(() => {})
        })
        .catch(() => { setTxData([]) })
        .finally(() => setLoading(false))
    }
  }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  // General Report (branch summary) is restaurant-account-wide, not branch-scoped —
  // fetched independently of the other tabs' per-branch Promise.all calls above
  useEffect(() => {
    if (activeTab !== 'general' || !initialPeriodReady) return
    const { start, end } = rangeMode === 'custom' ? { start: draftFrom, end: draftTo } : getDateRange(period)
    let cancelled = false
    fetch(`/api/restaurant/reports/branch-summary?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled) setBranchSummaryData(data) })
      .catch(() => { if (!cancelled) setBranchSummaryData(null) })
    return () => { cancelled = true }
  }, [activeTab, period, rangeMode, draftFrom, draftTo, initialPeriodReady])

  // Upselling is restaurant-account-wide for the same reason the General Report
  // is: one bill routinely spans stations, and slicing it per station would
  // report a burger-and-a-soda check as "no drink attached" at the grill.
  useEffect(() => {
    if (activeTab !== 'upselling' || !initialPeriodReady) return
    const { start, end } = rangeMode === 'custom' ? { start: draftFrom, end: draftTo } : getDateRange(period)
    let cancelled = false
    fetch(`/api/restaurant/reports/upselling?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled) setUpsellingData(data) })
      .catch(() => { if (!cancelled) setUpsellingData(null) })
    return () => { cancelled = true }
  }, [activeTab, period, rangeMode, draftFrom, draftTo, initialPeriodReady])

  const buildBranchSummaryDoc = useCallback((rangeLabel: string) => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const ORANGE: [number, number, number] = [234, 88, 12]
    const td = { headStyles: { fillColor: ORANGE, textColor: 255, fontStyle: 'bold' as const, fontSize: 9 }, bodyStyles: { fontSize: 8 }, alternateRowStyles: { fillColor: [255, 247, 237] as [number, number, number] }, margin: { left: 14, right: 14 }, styles: { cellPadding: 2.5 } }

    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(20, 20, 20)
    doc.text('General Report — Sales by Station', 14, 18)
    doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(110, 110, 110)
    doc.text(`Report period: ${rangeLabel}`, 14, 25)

    const rows = branchSummaryData?.rows ?? []
    const totals = branchSummaryData?.totals ?? { totalSales: 0, totalCost: 0, totalProfit: 0 }
    const overallMargin = totals.totalSales > 0 ? Math.round((totals.totalProfit / totals.totalSales) * 1000) / 10 : 0

    autoTable(doc, {
      ...td,
      startY: 32,
      head: [['Station', 'Sales Amount (RWF)', '% of Sales', 'Cost of Goods (RWF)', 'Profit / Loss (RWF)', 'Margin %']],
      body: rows.map((r) => [r.branchName, fmt(r.sales), `${r.percentOfSales.toFixed(1)}%`, fmt(r.cost), `${r.profit >= 0 ? '' : '-'}${fmt(Math.abs(r.profit))}`, `${r.marginPercent.toFixed(1)}%`]),
      foot: [['GROSS TOTAL', fmt(totals.totalSales), '100.0%', fmt(totals.totalCost), `${totals.totalProfit >= 0 ? '' : '-'}${fmt(Math.abs(totals.totalProfit))}`, `${overallMargin.toFixed(1)}%`]],
      footStyles: { fillColor: [17, 24, 39], textColor: 255, fontStyle: 'bold' },
    })
    return doc
  }, [branchSummaryData])

  const exportBranchSummaryPdf = useCallback(async () => {
    setBranchSummaryExporting(true)
    try {
      const rangeLabel = rangeMode === 'custom' ? `${draftFrom} to ${draftTo}` : loadedPeriod
      const doc = buildBranchSummaryDoc(rangeLabel)
      const fileName = `General-Report-${todayStr()}.pdf`

      // Electron desktop: write straight to disk (auto-numbered if the name already exists)
      // and reveal it in Explorer, instead of relying on the browser download flow.
      if (typeof window !== 'undefined' && window.electronFiles) {
        const base64 = arrayBufferToBase64(doc.output('arraybuffer'))
        const result = await window.electronFiles.saveAndReveal(fileName, base64)
        if (result.ok) return
      }
      doc.save(fileName)
    } finally {
      setBranchSummaryExporting(false)
    }
  }, [buildBranchSummaryDoc, rangeMode, draftFrom, draftTo, loadedPeriod])

  const shareBranchSummaryPdf = useCallback(async () => {
    setBranchSummaryExporting(true)
    try {
      const rangeLabel = rangeMode === 'custom' ? `${draftFrom} to ${draftTo}` : loadedPeriod
      const doc = buildBranchSummaryDoc(rangeLabel)
      const fileName = `General-Report-${todayStr()}.pdf`

      // Real "choose an app" share sheet — only exists on mobile browsers / some desktop
      // browsers via the Web Share API. Electron does not implement this API at all.
      const blob = doc.output('blob')
      const file = new File([blob], fileName, { type: 'application/pdf' })
      const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { canShare?: (data?: any) => boolean; share?: (data: any) => Promise<void> }) : null
      if (nav?.canShare?.({ files: [file] }) && nav.share) {
        try {
          await nav.share({ files: [file], title: 'General Report', text: `General Report (${rangeLabel})` })
        } catch {
          // user cancelled the native share sheet — nothing else to do
        }
        return
      }

      // Electron desktop has no native share-sheet API. Best available option: save the
      // file and reveal it in Explorer, where right-click > Share opens Windows' real
      // share flyout (WhatsApp Desktop, Mail, Nearby Share, etc.).
      if (typeof window !== 'undefined' && window.electronFiles) {
        const base64 = arrayBufferToBase64(doc.output('arraybuffer'))
        const result = await window.electronFiles.saveAndReveal(fileName, base64)
        if (result.ok) return
      }

      doc.save(fileName)
    } finally {
      setBranchSummaryExporting(false)
    }
  }, [buildBranchSummaryDoc, rangeMode, draftFrom, draftTo, loadedPeriod])

  const exportAllPDF = useCallback(async () => {
    setExporting(true)
    try {
      const { start, end, label } = rangeMode === 'custom'
        ? { start: draftFrom, end: draftTo, label: `${draftFrom} - ${draftTo}` }
        : getDateRange(period)
      const [txRes, dashRes, dpRes, imRes, tiRes] = await Promise.all([
        fetch(`/api/transactions?startDate=${start}&endDate=${end}`, FRESH_FETCH_OPTIONS),
        fetch(rangeMode === 'custom' ? `/api/restaurant/dashboard?from=${start}&to=${end}` : `/api/restaurant/dashboard?period=${period}`, FRESH_FETCH_OPTIONS),
        fetch(`/api/restaurant/reports/dish-profitability?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
        fetch(`/api/restaurant/reports/inventory-movement?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
        fetch(`/api/restaurant/reports/theoretical-inventory?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
      ])
      let txs: any[] = []
      let dash: any = null
      let dishProfit: any = null
      let invMovement: any = null
      let theoreticalInv: any = null
      if (txRes.ok) { const d = await txRes.json(); txs = normalizeTransactions(Array.isArray(d)?d:(d.transactions??d.data??[])) }
      if (dashRes.ok) { dash = await dashRes.json() }
      if (dpRes.ok) { dishProfit = await dpRes.json() }
      if (imRes.ok) { invMovement = await imRes.json() }
      if (tiRes.ok) { theoreticalInv = await tiRes.json() }

      const doc = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' })
      const pw = doc.internal.pageSize.getWidth()
      const ph = doc.internal.pageSize.getHeight()
      const ORANGE: [number,number,number] = [234,88,12]
      const td = { headStyles:{fillColor:ORANGE,textColor:255,fontStyle:'bold' as const,fontSize:9}, bodyStyles:{fontSize:8}, alternateRowStyles:{fillColor:[255,247,237] as [number,number,number]}, margin:{left:14,right:14}, styles:{cellPadding:2.5} }

      // Cover
      doc.setFillColor(...ORANGE); doc.rect(0,0,pw,ph,'F')
      doc.setTextColor(255,255,255)
      doc.setFontSize(28); doc.setFont('helvetica','bold'); doc.text('Jesse AI',pw/2,80,{align:'center'})
      doc.setFontSize(16); doc.setFont('helvetica','normal'); doc.text('Complete Financial Report',pw/2,95,{align:'center'})
      doc.setDrawColor(255,255,255); doc.setLineWidth(0.5); doc.line(20,105,pw-20,105)
      doc.setFontSize(11)
      doc.text(`Period: ${label}`,pw/2,116,{align:'center'})
      doc.text(`Generated: ${new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}`,pw/2,125,{align:'center'})
      doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.text('CONTENTS',pw/2,148,{align:'center'})
      doc.setFont('helvetica','normal'); doc.setFontSize(9)
      ;['1. Profit Margin Dashboard','2. Journal Ledger','3. Accounts Receivable','4. Accounts Payable','5. Cash Flow Statement','6. Balance Sheet','7. Income Statement (P&L)','8. Payment Methods','9. Orders Report','10. Inventory Movement','11. Theoretical Inventory']
        .forEach((c,i)=>doc.text(c,pw/2,157+i*8,{align:'center'}))
      doc.setFontSize(8); doc.text('Prepared by Jesse AI  Your Restaurant Financial Intelligence System',pw/2,ph-15,{align:'center'})

      const section=(title:string,sub:string)=>{
        doc.addPage()
        doc.setFillColor(249,250,251); doc.rect(0,0,pw,30,'F')
        doc.setDrawColor(...ORANGE); doc.setLineWidth(1); doc.line(0,30,pw,30)
        doc.setTextColor(17,24,39); doc.setFontSize(14); doc.setFont('helvetica','bold'); doc.text(title,14,13)
        doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(107,114,128); doc.text(sub,14,22)
        doc.setTextColor(0,0,0); return 38
      }
      const sub=(title:string,y:number)=>{ doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(17,24,39); doc.text(title,14,y); return y+5 }

      const totalDr=txs.filter(t=>t.type==='debit').reduce((s,t)=>s+t.amount,0)
      const totalCr=txs.filter(t=>t.type==='credit').reduce((s,t)=>s+t.amount,0)
      const paymentCollections = buildPaymentMethodSummaries(txs)

      // 1. Dashboard
      let y=section('Profit Margin Dashboard',`Key performance indicators  ${label}`)
      if(dash){
        const rev=dash.revenue??0
        autoTable(doc,{...td,startY:y,head:[['Metric','Amount (RWF)','% of Revenue','Target','Status']],body:[
          ['Total Revenue',fmt(rev),'100%','',''],
          ['Food Cost (COGS)',fmt(dash.cogs??0),`${dash.foodCostPct??0}%`,'25-35%',dash.foodCostPct<=35?' Good':' High'],
          ['Labor Cost',fmt(dash.laborCost??0),`${dash.laborPct??0}%`,'25-35%',dash.laborPct<=35?' Good':' High'],
          ['Waste Cost',fmt(dash.wasteCost??0),`${dash.wastePct??0}%`,'<5%',dash.wastePct<=5?' Good':' High'],
          ['Prime Cost',fmt(dash.primeCost??0),`${dash.primeCostPct??0}%`,'<60%',dash.primeCostPct<=60?' Good':dash.primeCostPct<=65?' Watch':' High'],
          ['Gross Profit',fmt(rev-(dash.cogs??0)-(dash.laborCost??0)-(dash.wasteCost??0)),'','',''],
        ]})
        y=(doc as any).lastAutoTable.finalY+10
        if(dash.topDishes?.length>0){
          y=sub('Top Performing Dishes',y)
          autoTable(doc,{...td,startY:y,head:[['#','Dish','Portions','Revenue (RWF)','Avg/Portion']],body:dash.topDishes.map((d:any,i:number)=>[i+1,d.name,d.orders,fmt(d.revenue),d.orders>0?fmt(d.revenue/d.orders):'0'])})
        }
      }

      // 2. Journal
      y=section('Journal Ledger',`All ${txs.length} transactions  ${label}`)
      doc.setFontSize(8); doc.setTextColor(55,65,81); doc.text(`Entries: ${txs.length}  |  Debits: ${fmt(totalDr)} RWF  |  Credits: ${fmt(totalCr)} RWF`,14,y); y+=5
      autoTable(doc,{...td,startY:y,head:[['Date','Account','Description','Type','Debit (RWF)','Credit (RWF)']],body:txs.map(t=>[t.date?.slice(0,10)??'',t.account?.name??'',(t.description??'').slice(0,40),t.type?.toUpperCase(),t.type==='debit'?fmt(t.amount):'',t.type==='credit'?fmt(t.amount):''])})

      // 3. A/R
      y=section('Accounts Receivable',`Outstanding receivables  ${label}`)
      const ar=txs.filter(isReceivableTransaction)
      if(ar.length>0){
        autoTable(doc,{...td,startY:y,head:[['Date','Description','Account','Effect (RWF)']],body:ar.map(t=>[t.date?.slice(0,10)??'',(t.description??'').slice(0,50),t.account?.name??'',`${getReceivableEffect(t)>=0?'+':'-'}${fmt(Math.abs(getReceivableEffect(t)))}`])})
        y=(doc as any).lastAutoTable.finalY+4; doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...ORANGE)
        doc.text(`Total: ${fmt(ar.reduce((s,t)=>s+getReceivableEffect(t),0))} RWF`,pw-14,y,{align:'right'})
      } else { doc.setFontSize(9); doc.setTextColor(107,114,128); doc.text('No A/R records found.',14,y) }

      // 4. A/P
      y=section('Accounts Payable',`Outstanding payables  ${label}`)
      const ap=txs.filter(isPayableTransaction)
      if(ap.length>0){
        autoTable(doc,{...td,startY:y,head:[['Date','Description','Account','Category','Effect (RWF)']],body:ap.map(t=>[t.date?.slice(0,10)??'',(t.description??'').slice(0,40),t.account?.name??'',t.account?.category?.type??'',`${getPayableEffect(t)>=0?'+':'-'}${fmt(Math.abs(getPayableEffect(t)))}`])})
        y=(doc as any).lastAutoTable.finalY+4; doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...ORANGE)
        doc.text(`Total: ${fmt(ap.reduce((s,t)=>s+getPayableEffect(t),0))} RWF`,pw-14,y,{align:'right'})
      } else { doc.setFontSize(9); doc.setTextColor(107,114,128); doc.text('No A/P records found.',14,y) }

      // 5. Cash Flow
      y=section('Cash Flow Statement',`Cash movements  ${label}`)
      const cashTxs=txs.filter(usesCashSettlement)
      const inf=cashTxs.filter(t=>getTransactionFlow(t)==='in').reduce((s,t)=>s+t.amount,0)
      const outf=cashTxs.filter(t=>getTransactionFlow(t)==='out').reduce((s,t)=>s+t.amount,0)
      autoTable(doc,{...td,startY:y,head:[['Cash Flow Summary','Amount (RWF)']],body:[['Total Cash Inflows',fmt(inf)],['Total Cash Outflows',fmt(outf)],['Net Cash Movement',fmt(inf-outf)]]})
      y=(doc as any).lastAutoTable.finalY+6
      if(cashTxs.length>0){ y=sub('Transaction Detail',y); autoTable(doc,{...td,startY:y,head:[['Date','Description','Flow','Amount (RWF)']],body:cashTxs.map(t=>[t.date?.slice(0,10)??'',(t.description??'').slice(0,50),getTransactionFlow(t)==='in'?'Inflow ':'Outflow ',fmt(t.amount)])}) }

      // 6. Balance Sheet
      y=section('Balance Sheet',`Account balances as of ${label}`)
      const bmap=new Map<string,{dr:number;cr:number;cat:string}>()
      txs.forEach(t=>{ const n=t.account?.name??'Unknown',c=t.account?.category?.type??'',p=bmap.get(n)??{dr:0,cr:0,cat:c}; if(t.type==='debit')p.dr+=t.amount;else p.cr+=t.amount; bmap.set(n,p) })
      const brows=[...bmap.entries()].map(([n,{dr,cr,cat}])=>[n,cat,fmt(dr),fmt(cr),(dr-cr>=0?'DR ':'CR ')+fmt(Math.abs(dr-cr))]).sort((a,b)=>String(a[1]).localeCompare(String(b[1])))
      autoTable(doc,{...td,startY:y,head:[['Account','Category','Debit (RWF)','Credit (RWF)','Net Balance']],body:brows})
      y=(doc as any).lastAutoTable.finalY+4; doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...ORANGE)
      doc.text(`Totals  Dr: ${fmt(totalDr)} RWF  |  Cr: ${fmt(totalCr)} RWF`,pw-14,y,{align:'right'})

      // 7. Income Statement
      y=section('Income Statement (P&L)',`Revenue and expenses  ${label}`)
      const revT=txs.filter(isIncomeTransaction)
      const expT=txs.filter(isExpenseTransaction)
      const tRev=revT.reduce((s,t)=>s+getIncomeEffect(t),0), tExp=expT.reduce((s,t)=>s+getExpenseEffect(t),0), netP=tRev-tExp
      autoTable(doc,{...td,startY:y,head:[['Line Item','Amount (RWF)']],body:[['Total Revenue',fmt(tRev)],['Total Expenses',fmt(tExp)],['Net Profit / (Loss)',(netP<0?'(':'')+fmt(Math.abs(netP))+(netP<0?')':'')]]})
      y=(doc as any).lastAutoTable.finalY+6
      if(revT.length>0){ y=sub('Revenue Detail',y); autoTable(doc,{...td,startY:y,head:[['Date','Account','Description','Effect (RWF)']],body:revT.map(t=>[t.date?.slice(0,10)??'',t.account?.name??'',(t.description??'').slice(0,40),`${getIncomeEffect(t)>=0?'+':'-'}${fmt(Math.abs(getIncomeEffect(t)))}`])}); y=(doc as any).lastAutoTable.finalY+6 }
      if(expT.length>0){ y=sub('Expense Detail',y); autoTable(doc,{...td,startY:y,head:[['Date','Account','Description','Effect (RWF)']],body:expT.map(t=>[t.date?.slice(0,10)??'',t.account?.name??'',(t.description??'').slice(0,40),`${getExpenseEffect(t)>=0?'+':'-'}${fmt(Math.abs(getExpenseEffect(t)))}`])}) }

      // 8. Payment Methods
      y=section('Payment Methods',`Collected sales by payment method  ${label}`)
      if(paymentCollections.methods.length>0){
        autoTable(doc,{...td,startY:y,head:[['Method','Sales','Collected (RWF)']],body:paymentCollections.methods.map((method)=>[method.label,method.count,fmt(method.totalAmount)])})
        y=(doc as any).lastAutoTable.finalY+4; doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...ORANGE)
        doc.text(`Totals  Sales: ${paymentCollections.totalCount}  |  Collected: ${fmt(paymentCollections.totalAmount)} RWF`,14,y)
        y+=6
        y=sub('Payment History',y)
        autoTable(doc,{...td,startY:y,head:[['Date / Time','Method','Client','What Was Bought','Amount (RWF)']],body:paymentCollections.events.map((event)=>[formatReportDateTime(event.date || event.createdAt),paymentMethodButtonLabel(event.paymentMethod),event.clientLabel,event.itemLabel,fmt(event.amount)])})
      } else { doc.setFontSize(9); doc.setTextColor(107,114,128); doc.text('No collected sales were found for this period.',14,y) }

      // 9. Orders Report
      y=section('Orders Report',`Orders, status and profitability  ${label}`)
      if((dishProfit?.orders ?? dishProfit?.dishes)?.length>0){
        const dp=dishProfit.orders ?? dishProfit.dishes; const dt=dishProfit.totals??{}
        autoTable(doc,{...td,startY:y,head:[['Order','Waiter','Status','Qty','Cost','Price','Total','Profit']],
          body:dp.map((d:any)=>[(d.orderLabel??d.dishName), (d.waiterName ?? 'Unknown'), statusLabel(d.status), d.qtySold, fmt(d.totalCost), fmt(d.unitPrice), fmt(d.totalPrice??d.totalRevenue), (d.totalProfit>=0?'':'-')+fmt(Math.abs(d.totalProfit))])})
        y=(doc as any).lastAutoTable.finalY+4; doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...ORANGE)
        doc.text(`Totals  Revenue: ${fmt(dt.totalRevenue??0)} RWF  |  Profit: ${fmt(dt.totalProfit??0)} RWF`,14,y)
      } else { doc.setFontSize(9); doc.setTextColor(107,114,128); doc.text('No paid orders recorded for this period.',14,y) }

      // 10. Inventory Movement
      y=section('Inventory Movement',`Stock purchased vs used  ${label}`)
      if(invMovement?.items?.length>0){
        const im=invMovement.items; const it=invMovement.totals??{}
        autoTable(doc,{...td,startY:y,head:[['Ingredient','Unit','Opening','Bought Qty','Purchase Cost','Used Qty','Used Cost','Remaining','Stock Value','Status']],
          body:im.map((i:any)=>[i.ingredientName,i.unit,i.openingQty,i.purchasedQty,fmt(i.purchaseCost),i.usedQty,fmt(i.usedCost),i.remainingQty,fmt(i.stockValue),i.isLow?'Low':'OK'])})
        y=(doc as any).lastAutoTable.finalY+4; doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...ORANGE)
        doc.text(`Totals  Purchased: ${fmt(it.totalPurchaseCost??0)} RWF  |  Used: ${fmt(it.totalUsedCost??0)} RWF  |  Stock Value: ${fmt(it.totalStockValue??0)} RWF`,14,y)
      } else { doc.setFontSize(9); doc.setTextColor(107,114,128); doc.text('No inventory data found. Add ingredients and record purchases.',14,y) }

      // 11. Theoretical Inventory
      y=section('Theoretical Inventory',`Expected stock vs actual on hand  ${label}`)
      if(theoreticalInv?.items?.length>0){
        const ti=theoreticalInv.items; const tt=theoreticalInv.totals??{}
        autoTable(doc,{...td,startY:y,head:[['Ingredient','Opening','Bought','Used','Waste','Theory','Actual','Variance','Variance Cost']],
          body:ti.map((i:any)=>[i.ingredientName,i.openingQty,i.purchasedQty,i.usedQty,i.wasteQty,i.theoreticalQty,i.actualQty,i.varianceQty,fmt(i.varianceCost)])})
        y=(doc as any).lastAutoTable.finalY+4; doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...ORANGE)
        doc.text(`Totals  Used: ${fmt(tt.totalUsedCost??0)} RWF  |  Waste: ${fmt(tt.totalWasteCost??0)} RWF  |  Variance: ${fmt(tt.totalVarianceCost??0)} RWF`,14,y)
      } else { doc.setFontSize(9); doc.setTextColor(107,114,128); doc.text('No theoretical inventory data found for this period.',14,y) }

      // Page footers
      const pg=(doc as any).internal.getNumberOfPages()
      for(let i=2;i<=pg;i++){ doc.setPage(i); doc.setFontSize(7); doc.setTextColor(156,163,175); doc.text(`Jesse AI Financial Report  ${label}`,14,ph-8); doc.text(`Page ${i} of ${pg}`,pw-14,ph-8,{align:'right'}) }

      doc.save(`Jesse-AI-Financial-Report-${period}-${formatLocalDate(new Date())}.pdf`)
    } catch(e:any) { alert('Export failed: '+e.message) }
    finally { setExporting(false) }
  }, [draftFrom, draftTo, period, rangeMode])

  useEffect(() => {
    // Use periodTxData (full period) so auto-selection is stable when a day card is clicked
    const chipSource = buildHistoryDateRows(activeTab, periodTxData ?? txData)
    const dates = Array.from(new Set((chipSource ?? []).map((row: any) => String(row.date ?? '').slice(0, 10)).filter(Boolean))).sort()
    if (dates.length === 0) {
      setSelectedHistoryDate(today)
      return
    }
    setSelectedHistoryDate((current) => dates.includes(current) ? current : dates[dates.length - 1])
  }, [activeTab, periodTxData, txData, today])

  // Date chips: show every calendar day for week/month/custom (≤31 days) so the
  // user can browse any day even if it had no transactions. For longer ranges
  // (quarter, year) only show days that actually had activity to avoid clutter.
  const chipSource = buildHistoryDateRows(activeTab, periodTxData ?? txData)
  const activityDates = new Set(
    (chipSource ?? []).map((row: any) => String(row.date ?? '').slice(0, 10)).filter(Boolean)
  )
  const { start: periodStart, end: periodEnd } = rangeMode === 'custom'
    ? { start: draftFrom, end: draftTo }
    : getDateRange(period)
  const daySpan = Math.round((parseLocalDate(periodEnd).getTime() - parseLocalDate(periodStart).getTime()) / 86400000) + 1
  const showAllDays = daySpan <= 31 && period !== 'today'
  const chipDates: string[] = showAllDays
    ? allDatesInRange(periodStart, periodEnd)
    : Array.from(activityDates).sort()
  const dailyRows = chipDates.map((date) => ({
    date,
    count: (chipSource ?? []).filter((row: any) => String(row.date ?? '').slice(0, 10) === date).length,
    hasActivity: activityDates.has(date),
  }))

  const applyPreset = (nextPeriod: Period) => {
    setRangeMode('preset')
    setPeriod(nextPeriod)
  }

  const applyCustomRange = () => {
    if (!draftFrom || !draftTo) return
    if (draftFrom > draftTo) return
    setRangeMode('custom')
  }

  const currentTab = TABS.find(t=>t.id===activeTab)!

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-gray-800">Financial Reports</h2>
            {RESTAURANT_WIDE_TABS.has(activeTab) ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 border border-gray-300 px-2.5 py-0.5 text-xs font-medium text-gray-600">
                <span className="h-1.5 w-1.5 rounded-full bg-gray-400 flex-shrink-0" />
                All stations
              </span>
            ) : (
              <BranchBadge />
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div className="p-0.5 rounded bg-gradient-to-br from-orange-500 to-red-600">
              <Sparkles className="h-3 w-3 text-white"/>
            </div>
            <p className="text-xs text-gray-500">All financial reports are prepared by <span className="font-semibold text-orange-600">Jesse AI</span> from your live transaction data</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
        {onAskJesse && (
          <button disabled
            className="flex items-center gap-2 bg-gradient-to-r from-orange-500 to-red-600 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-sm opacity-60 cursor-not-allowed">
            <Sparkles className="h-3.5 w-3.5"/>
            Ask Jesse AI
            <span className="text-[10px] font-bold bg-white/25 rounded px-1.5 py-0.5 leading-none">Soon</span>
          </button>
        )}
        <button onClick={exportAllPDF} disabled={exporting}
          className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-sm transition-colors flex-shrink-0">
          {exporting?<Loader2 className="h-3.5 w-3.5 animate-spin"/>:<Download className="h-3.5 w-3.5"/>}
          {exporting?'Building PDF':'Export Full Report PDF'}
        </button>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {TABS.map(tab=>{
          const Icon=tab.icon
          return (
            <button key={tab.id} onClick={()=>{ setActiveTab(tab.id) }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-all flex-shrink-0 ${activeTab===tab.id?'bg-orange-500 text-white shadow-sm':'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              <Icon className="h-3.5 w-3.5"/>
              {tab.short}
            </button>
          )
        })}
      </div>

      {/* Tab card */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">

        {/* Tab header */}
        <div className="bg-gradient-to-r from-gray-50 to-white border-b border-gray-100 px-5 py-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-orange-100">
                <currentTab.icon className="h-5 w-5 text-orange-600"/>
              </div>
              <div>
                <h3 className="font-bold text-gray-900 text-base">{currentTab.label}</h3>
                <p className="text-xs text-gray-500 mt-0.5">{currentTab.desc}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {(['today','week','month','quarter','year'] as Period[]).map(p=>(
                <button key={p} onClick={()=>applyPreset(p)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${rangeMode === 'preset' && period===p?'bg-orange-500 text-white shadow-sm':'bg-white border border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                  {PERIOD_LABELS[p]}
                </button>
              ))}
              <div className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 ${rangeMode === 'custom' ? 'border-orange-300 bg-orange-50' : 'border-gray-200 bg-white'}`}>
                <input type="date" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} className="bg-transparent text-xs outline-none text-gray-600" />
                <span className="text-xs text-gray-400">to</span>
                <input type="date" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} className="bg-transparent text-xs outline-none text-gray-600" />
                <button onClick={applyCustomRange} className="inline-flex items-center gap-1 rounded-md bg-gray-900 px-2 py-1 text-[11px] font-semibold text-white hover:bg-black">
                  <CalendarRange className="h-3 w-3" />
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Content area */}
        <div className="p-5">

          {/* The day chips drill into a single day via fetchReportRange, which only
              refreshes the per-branch reports. General and Upselling fetch
              independently (they are restaurant-account-wide), so the chips would
              highlight a day while their numbers still showed the whole range.
              A single day is also too few orders for Upselling to say anything. */}
          {activeTab !== 'payment_methods' && activeTab !== 'general' && activeTab !== 'upselling' && dailyRows.length > 0 ? (
            <div className="mb-4 space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-gray-500">{rangeMode === 'custom' ? `Custom range: ${draftFrom} - ${draftTo}` : loadedPeriod}</p>
                <p className="text-xs text-gray-400">{periodTxData && txData && periodTxData !== txData ? 'Day view — click a period pill above to see the full range' : showAllDays ? 'All days in range — highlighted days have activity' : 'Activity days in this range'}</p>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {dailyRows.map((row) => {
                  const chip = formatDayChip(row.date)
                  const isSelected = row.date === selectedHistoryDate
                  return (
                    <button
                      key={row.date}
                      onClick={() => {
                        setSelectedHistoryDate(row.date)
                        fetchReportRange(row.date, row.date, formatDayChip(row.date).display, false)
                      }}
                      className={`min-w-[110px] rounded-xl border px-4 py-3 text-left transition-all ${
                        isSelected
                          ? 'border-orange-300 bg-orange-50 shadow-sm'
                          : row.hasActivity
                            ? 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                            : 'border-gray-100 bg-white hover:bg-gray-50 opacity-60'
                      }`}
                    >
                      <p className={`text-xs font-semibold ${isSelected ? 'text-orange-600' : row.hasActivity ? 'text-gray-500' : 'text-gray-400'}`}>{chip.weekday}</p>
                      <p className={`mt-1 text-base font-semibold ${isSelected ? 'text-orange-700' : row.hasActivity ? 'text-gray-900' : 'text-gray-400'}`}>{chip.display}</p>
                      <p className={`mt-1 text-xs ${isSelected ? 'text-orange-600' : row.hasActivity ? 'text-gray-500' : 'text-gray-300'}`}>{row.hasActivity ? `${row.count} ${row.count === 1 ? 'entry' : 'entries'}` : 'no activity'}</p>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}



          {/* Loading */}
          {loading&&(
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center shadow-lg mb-4 animate-pulse">
                <Sparkles className="h-8 w-8 text-white"/>
              </div>
              <div className="flex items-center gap-2 text-orange-600 font-semibold text-sm mb-1">
                <Loader2 className="h-4 w-4 animate-spin"/>
                Loading your {currentTab.label}
              </div>
              <p className="text-xs text-gray-400">Fetching transactions and building the table</p>
            </div>
          )}

          {/* Report tables */}
          {(txData || activeTab==='dish_profit' || activeTab==='inventory_movement' || activeTab==='theoretical_inventory' || activeTab==='general' || activeTab==='upselling')&&!loading&&(
            <div className="space-y-2">
              {/* Attribution */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-orange-500"/>
                  <span className="text-xs font-semibold text-orange-700">Prepared by Jesse AI</span>
                  <span className="text-xs text-orange-400"> {loadedPeriod}</span>
                </div>
                <button onClick={() => {
                  if (rangeMode === 'custom') {
                    fetchReportRange(draftFrom, draftTo, `${draftFrom} - ${draftTo}`)
                    return
                  }
                  fetchReport(period)
                }}
                  className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-orange-600 transition-colors">
                  <RefreshCw className="h-3 w-3"/> Refresh
                </button>
              </div>

              {activeTab==='general'    &&<BranchSummaryTable data={branchSummaryData} exporting={branchSummaryExporting} onExportPdf={exportBranchSummaryPdf} onSharePdf={shareBranchSummaryPdf}/>}
              {activeTab==='journal'    &&<JournalTable     txs={txData??[]}/>}
              {activeTab==='receivable' &&<ReceivableTable  txs={txData??[]}/>}
              {activeTab==='payable'    &&<PayableTable     txs={txData??[]}/>}
              {activeTab==='cashflow'   &&<CashFlowTable    txs={txData??[]}/>}
              {activeTab==='balance'    &&<BalanceSheetTable txs={txData??[]}/>}
              {activeTab==='income'     &&<IncomeTable      txs={txData??[]}/>}
              {activeTab==='payment_methods' &&<PaymentMethodsTable txs={txData??[]}/>} 
              {activeTab==='dish_profit'        &&<DishProfitTable        data={dishProfitData}/>}
              {activeTab==='upselling'          &&<UpsellingTable         data={upsellingData}/>}
              {activeTab==='inventory_movement' &&<InventoryMovementTable data={invMovementData}/>}
              {activeTab==='theoretical_inventory' &&<TheoreticalInventoryTable data={theoreticalInvData} onCountSaved={() => {
                const { start, end } = rangeMode === 'custom' ? { start: draftFrom, end: draftTo } : getDateRange(period)
                fetch(`/api/restaurant/reports/theoretical-inventory?from=${start}&to=${end}`, { credentials: 'include', cache: 'no-store' })
                  .then(r => r.ok ? r.json() : null).then(d => { if (d) setTheoreticalInvData(d) }).catch(() => undefined)
              }} />}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

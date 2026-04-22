'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { Sparkles, Loader2, BookOpen, TrendingUp, CreditCard, ArrowLeftRight, BarChart3, FileText, RefreshCw, Download, Utensils, Package, CalendarRange } from 'lucide-react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

type ReportTab = 'journal' | 'receivable' | 'payable' | 'cashflow' | 'balance' | 'income' | 'dish_profit' | 'inventory_movement' | 'theoretical_inventory'
type Period = 'today' | 'week' | 'month' | 'quarter' | 'year'

function statusLabel(value: string | null | undefined) {
  if (!value) return 'PAID'
  return String(value).replace(/_/g, ' ')
}

const TABS: { id: ReportTab; label: string; short: string; icon: React.ElementType; desc: string }[] = [
  { id:'journal',    label:'Journal Ledger',         short:'Journal',   icon:BookOpen,       desc:'All recorded transactions in chronological order' },
  { id:'receivable', label:'Accounts Receivable',    short:'A/R',       icon:TrendingUp,     desc:'Money customers owe your business' },
  { id:'payable',    label:'Accounts Payable',       short:'A/P',       icon:CreditCard,     desc:'Money your business owes to suppliers' },
  { id:'cashflow',   label:'Cash Flow Statement',    short:'Cash Flow', icon:ArrowLeftRight, desc:'Cash inflows and outflows analysis' },
  { id:'balance',    label:'Balance Sheet',          short:'Balance',   icon:BarChart3,      desc:'Assets, liabilities and equity snapshot' },
  { id:'income',            label:'Income Statement (P&L)', short:'P&L',       icon:FileText,   desc:'Revenue, expenses and net profit' },
  { id:'dish_profit',       label:'Orders Report',          short:'Orders',      icon:Utensils,   desc:'Orders, waiter, status, quantity sold, cost, price, total price, revenue and profit' },
  { id:'inventory_movement', label:'Inventory Movement',    short:'Inventory',   icon:Package,    desc:'Opening stock, in-period purchases, usage, remaining quantity and stock value' },
  { id:'theoretical_inventory', label:'Theoretical Inventory', short:'Theory Inv', icon:Package, desc:'Opening stock, expected usage, waste, theoretical closing and variance versus actual stock' },
]

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

function normalizeTransactions(rows: any[]) {
  return rows.map((row) => ({
    ...row,
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
        rows={txs.map(t=>[t.date?.slice(0,10)??'', t.account?.name??'', (t.description??'').slice(0,48), t.type?.toUpperCase(), t.type==='debit'?fmt(t.amount):'', t.type==='credit'?fmt(t.amount):''])}
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
        rows={ar.map(t=>[t.date?.slice(0,10)??'',(t.description??'').slice(0,54),t.account?.name??'',`${getReceivableEffect(t)>=0?'+':'-'}${fmt(Math.abs(getReceivableEffect(t)))}`])}
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
        rows={ap.map(t=>[t.date?.slice(0,10)??'',(t.description??'').slice(0,42),t.account?.name??'',t.account?.category?.type??'',`${getPayableEffect(t)>=0?'+':'-'}${fmt(Math.abs(getPayableEffect(t)))}`])}
        foot={ap.length>0?['','','','TOTAL PAYABLE',fmt(total)]:undefined}
      />
    </>
  )
}

function CashFlowTable({ txs }: { txs: any[] }) {
  const cash = txs.filter(t=>isCashEquivalentAccountName(t.account?.name))
  const inflow  = cash.filter(t=>t.type==='debit').reduce((s,t)=>s+t.amount,0)
  const outflow = cash.filter(t=>t.type==='credit').reduce((s,t)=>s+t.amount,0)
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
            rows={cash.map(t=>[t.date?.slice(0,10)??'',(t.description??'').slice(0,50),t.type==='debit'?'Inflow ':'Outflow ',fmt(t.amount)])}
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
          <DataTable head={['Date','Account','Description','Effect (RWF)']} rows={rev.map(t=>[t.date?.slice(0,10)??'',t.account?.name??'',(t.description??'').slice(0,44),`${getIncomeEffect(t)>=0?'+':'-'}${fmt(Math.abs(getIncomeEffect(t)))}`])} foot={['','','TOTAL REVENUE',fmt(tRev)]} />
        </>
      )}
      {exp.length>0&&(
        <>
          <SectionTitle>Expense Detail</SectionTitle>
          <DataTable head={['Date','Account','Description','Effect (RWF)']} rows={exp.map(t=>[t.date?.slice(0,10)??'',t.account?.name??'',(t.description??'').slice(0,44),`${getExpenseEffect(t)>=0?'+':'-'}${fmt(Math.abs(getExpenseEffect(t)))}`])} foot={['','','TOTAL EXPENSES',fmt(tExp)]} />
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

function TheoreticalInventoryTable({ data }: { data: any }) {
  if (!data) return <div className="py-10 text-center text-gray-400 text-sm">Loading theoretical inventory data…</div>
  const items: any[] = data.items ?? []
  const totals: any = data.totals ?? {}
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard label="Ingredients" value={items.length.toString()} />
        <StatCard label="Theoretical Usage Cost" value={`${fmt(totals.totalUsedCost ?? 0)} RWF`} color="bg-red-50 border-red-200" />
        <StatCard label="Waste Cost" value={`${fmt(totals.totalWasteCost ?? 0)} RWF`} color="bg-orange-50 border-orange-200" />
        <StatCard label="Variance Cost" value={`${fmt(totals.totalVarianceCost ?? 0)} RWF`} color="bg-amber-50 border-amber-200" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard label="Matched Items" value={(totals.matchedCount ?? 0).toString()} color="bg-green-50 border-green-200" />
        <StatCard label="Variance Items" value={(totals.varianceCount ?? 0).toString()} color="bg-amber-50 border-amber-200" />
        <StatCard label="Theoretical Stock Value" value={`${fmt(totals.totalTheoreticalStockValue ?? 0)} RWF`} color="bg-blue-50 border-blue-200" />
        <StatCard label="Actual Stock Value" value={`${fmt(totals.totalActualStockValue ?? 0)} RWF`} color="bg-green-50 border-green-200" />
      </div>
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 mb-4">
        Theoretical stock is based on recorded purchases, recipe usage, and waste. Variance appears when stock was changed outside those records.
      </div>
      {items.length === 0 ? (
        <div className="py-8 text-center text-gray-400 text-sm">No theoretical inventory data found for this period.</div>
      ) : (
        <DataTable
          head={['Ingredient', 'Unit', 'Opening', 'Bought', 'Used', 'Waste', 'Theoretical', 'Actual', 'Variance', 'Variance Cost', 'Status']}
          rows={items.map((i:any) => [
            i.ingredientName,
            i.unit,
            i.openingQty,
            i.purchasedQty,
            i.usedQty,
            i.wasteQty,
            i.theoreticalQty,
            i.actualQty,
            i.varianceQty,
            fmt(i.varianceCost),
            i.varianceStatus,
          ])}
          foot={['TOTALS', '', '', '', '', '', '', '', '', fmt(totals.totalVarianceCost ?? 0), `${totals.varianceCount ?? 0} items`]}
        />
      )}
    </>
  )
}

//  MAIN COMPONENT 

export default function RestaurantReports({ onAskJesse }: { onAskJesse?: () => void }) {
  const [activeTab, setActiveTab] = useState<ReportTab>('journal')
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
  const [loadedPeriod, setLoadedPeriod] = useState<string>('')
  const [exporting, setExporting] = useState(false)
  const isFirstMount = useRef(true)

  const fetchReportRange = useCallback(async (start: string, end: string, label: string, isPeriodFetch = true) => {
    setLoading(true); setTxData(null); setDishProfitData(null); setInvMovementData(null); setTheoreticalInvData(null)
    try {
      const [txRes, dpRes, imRes, tiRes] = await Promise.all([
        fetch(`/api/transactions?startDate=${start}&endDate=${end}`, FRESH_FETCH_OPTIONS),
        fetch(`/api/restaurant/reports/dish-profitability?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
        fetch(`/api/restaurant/reports/inventory-movement?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
        fetch(`/api/restaurant/reports/theoretical-inventory?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
      ])
      if (txRes.ok) {
        const d = await txRes.json()
        const rawRows = Array.isArray(d)?d:(d.transactions??d.data??[])
        const normalized = normalizeTransactions(rawRows)
        setTxData(normalized)
        if (isPeriodFetch) setPeriodTxData(normalized)
        setLoadedPeriod(label)
      }
      if (dpRes.ok) setDishProfitData(await dpRes.json())
      if (imRes.ok) setInvMovementData(await imRes.json())
      if (tiRes.ok) setTheoreticalInvData(await tiRes.json())
    } catch { setTxData([]) }
    finally { setLoading(false) }
  }, [])

  const fetchReport = useCallback(async (p: Period) => {
    const { start, end, label } = getDateRange(p)
    await fetchReportRange(start, end, label)
  }, [fetchReportRange])

  // On mount: find the most recent period that actually has data so the page never opens empty
  useEffect(() => {
    async function autoSelectPeriod() {
      for (const p of ['today','week','month','quarter','year'] as Period[]) {
        const { start, end } = getDateRange(p)
        try {
          const freshRes = await fetch(`/api/transactions?startDate=${start}&endDate=${end}`, FRESH_FETCH_OPTIONS)
          if (freshRes.ok) {
            const d = await freshRes.json()
            const rows = normalizeTransactions(Array.isArray(d) ? d : (d.transactions ?? d.data ?? []))
            if (rows.length > 0) {
              const [dpRes, imRes, tiRes] = await Promise.all([
                fetch(`/api/restaurant/reports/dish-profitability?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
                fetch(`/api/restaurant/reports/inventory-movement?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
                fetch(`/api/restaurant/reports/theoretical-inventory?from=${start}&to=${end}`, FRESH_FETCH_OPTIONS),
              ])
              setPeriod(p)
              setRangeMode('preset')
              setTxData(rows)
              setPeriodTxData(rows)
              setLoadedPeriod(getDateRange(p).label)
              if (dpRes.ok) setDishProfitData(await dpRes.json())
              if (imRes.ok) setInvMovementData(await imRes.json())
              if (tiRes.ok) setTheoreticalInvData(await tiRes.json())
              return
            }
          }
        } catch { /* continue to next period */ }
      }
      // Nothing found in any period — just show month empty state
      setPeriod('month')
      setRangeMode('preset')
      fetchReport('month')
    }
    autoSelectPeriod()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch when period pill is clicked manually (skip initial mount — autoSelectPeriod handles that)
  useEffect(() => {
    if (isFirstMount.current) { isFirstMount.current = false; return }
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
      ;['1. Profit Margin Dashboard','2. Journal Ledger','3. Accounts Receivable','4. Accounts Payable','5. Cash Flow Statement','6. Balance Sheet','7. Income Statement (P&L)','8. Dish Profitability','9. Inventory Movement','10. Theoretical Inventory']
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
      const cashTxs=txs.filter(t=>isCashEquivalentAccountName(t.account?.name))
      const inf=cashTxs.filter(t=>t.type==='debit').reduce((s,t)=>s+t.amount,0)
      const outf=cashTxs.filter(t=>t.type==='credit').reduce((s,t)=>s+t.amount,0)
      autoTable(doc,{...td,startY:y,head:[['Cash Flow Summary','Amount (RWF)']],body:[['Total Cash Inflows',fmt(inf)],['Total Cash Outflows',fmt(outf)],['Net Cash Movement',fmt(inf-outf)]]})
      y=(doc as any).lastAutoTable.finalY+6
      if(cashTxs.length>0){ y=sub('Transaction Detail',y); autoTable(doc,{...td,startY:y,head:[['Date','Description','Flow','Amount (RWF)']],body:cashTxs.map(t=>[t.date?.slice(0,10)??'',(t.description??'').slice(0,50),t.type==='debit'?'Inflow ':'Outflow ',fmt(t.amount)])}) }

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

      // 8. Orders Report
      y=section('Orders Report',`Orders, status and profitability  ${label}`)
      if((dishProfit?.orders ?? dishProfit?.dishes)?.length>0){
        const dp=dishProfit.orders ?? dishProfit.dishes; const dt=dishProfit.totals??{}
        autoTable(doc,{...td,startY:y,head:[['Order','Waiter','Status','Qty','Cost','Price','Total','Profit']],
          body:dp.map((d:any)=>[(d.orderLabel??d.dishName), (d.waiterName ?? 'Unknown'), statusLabel(d.status), d.qtySold, fmt(d.totalCost), fmt(d.unitPrice), fmt(d.totalPrice??d.totalRevenue), (d.totalProfit>=0?'':'-')+fmt(Math.abs(d.totalProfit))])})
        y=(doc as any).lastAutoTable.finalY+4; doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...ORANGE)
        doc.text(`Totals  Revenue: ${fmt(dt.totalRevenue??0)} RWF  |  Profit: ${fmt(dt.totalProfit??0)} RWF`,14,y)
      } else { doc.setFontSize(9); doc.setTextColor(107,114,128); doc.text('No paid orders recorded for this period.',14,y) }

      // 9. Inventory Movement
      y=section('Inventory Movement',`Stock purchased vs used  ${label}`)
      if(invMovement?.items?.length>0){
        const im=invMovement.items; const it=invMovement.totals??{}
        autoTable(doc,{...td,startY:y,head:[['Ingredient','Unit','Opening','Bought Qty','Purchase Cost','Used Qty','Used Cost','Remaining','Stock Value','Status']],
          body:im.map((i:any)=>[i.ingredientName,i.unit,i.openingQty,i.purchasedQty,fmt(i.purchaseCost),i.usedQty,fmt(i.usedCost),i.remainingQty,fmt(i.stockValue),i.isLow?'Low':'OK'])})
        y=(doc as any).lastAutoTable.finalY+4; doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...ORANGE)
        doc.text(`Totals  Purchased: ${fmt(it.totalPurchaseCost??0)} RWF  |  Used: ${fmt(it.totalUsedCost??0)} RWF  |  Stock Value: ${fmt(it.totalStockValue??0)} RWF`,14,y)
      } else { doc.setFontSize(9); doc.setTextColor(107,114,128); doc.text('No inventory data found. Add ingredients and record purchases.',14,y) }

      // 10. Theoretical Inventory
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
    const chipSource = periodTxData ?? txData
    const dates = Array.from(new Set((chipSource ?? []).map((row: any) => String(row.date ?? '').slice(0, 10)).filter(Boolean))).sort()
    if (dates.length === 0) {
      setSelectedHistoryDate(today)
      return
    }
    setSelectedHistoryDate((current) => dates.includes(current) ? current : dates[dates.length - 1])
  }, [periodTxData, txData, today])

  // Date chips: show every calendar day for week/month/custom (≤31 days) so the
  // user can browse any day even if it had no transactions. For longer ranges
  // (quarter, year) only show days that actually had activity to avoid clutter.
  const chipSource = periodTxData ?? txData
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
          <h2 className="text-lg font-bold text-gray-800">Financial Reports</h2>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div className="p-0.5 rounded bg-gradient-to-br from-orange-500 to-red-600">
              <Sparkles className="h-3 w-3 text-white"/>
            </div>
            <p className="text-xs text-gray-500">All financial reports are prepared by <span className="font-semibold text-orange-600">Jesse AI</span> from your live transaction data</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
        {onAskJesse && (
          <button onClick={onAskJesse}
            className="flex items-center gap-2 bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-sm transition-colors">
            <Sparkles className="h-3.5 w-3.5"/>
            Ask Jesse AI
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

          {dailyRows.length > 0 ? (
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
          {(txData || activeTab==='dish_profit' || activeTab==='inventory_movement' || activeTab==='theoretical_inventory')&&!loading&&(
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

              {activeTab==='journal'    &&<JournalTable     txs={txData??[]}/>}
              {activeTab==='receivable' &&<ReceivableTable  txs={txData??[]}/>}
              {activeTab==='payable'    &&<PayableTable     txs={txData??[]}/>}
              {activeTab==='cashflow'   &&<CashFlowTable    txs={txData??[]}/>}
              {activeTab==='balance'    &&<BalanceSheetTable txs={txData??[]}/>}
              {activeTab==='income'     &&<IncomeTable      txs={txData??[]}/>}
              {activeTab==='dish_profit'        &&<DishProfitTable        data={dishProfitData}/>}
              {activeTab==='inventory_movement' &&<InventoryMovementTable data={invMovementData}/>}
              {activeTab==='theoretical_inventory' &&<TheoreticalInventoryTable data={theoreticalInvData}/>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

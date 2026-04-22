'use client'
import { useState, useEffect } from 'react'
import { History, ShoppingBag, ArrowLeftRight, Sparkles, RefreshCw, CalendarRange } from 'lucide-react'

type SaleItem = {
  id: string
  dish: { name: string }
  quantitySold: number
  totalSaleAmount: number
  paymentMethod: string
  saleDate: string
  table?: { name: string } | null
}

type TxItem = {
  id: string
  date: string
  description: string
  debit: number
  credit: number
  account: { name: string }
}

function fmtRWF(n: number) { return n.toLocaleString('en-RW', { maximumFractionDigits: 0 }) }

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function dayChip(date: string) {
  const value = new Date(`${date}T00:00:00`)
  return {
    weekday: value.toLocaleDateString('en-RW', { weekday: 'short' }),
    display: value.toLocaleDateString('en-RW', { month: 'numeric', day: 'numeric', year: 'numeric' }),
  }
}

export default function WaiterHistory({ onAskJesse }: { onAskJesse?: () => void }) {
  const today = todayStr()
  const [sales, setSales] = useState<SaleItem[]>([])
  const [txns, setTxns] = useState<TxItem[]>([])
  const [tab, setTab] = useState<'sales' | 'transactions'>('sales')
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today')
  const [rangeMode, setRangeMode] = useState<'preset' | 'custom'>('preset')
  const [draftFrom, setDraftFrom] = useState(today)
  const [draftTo, setDraftTo] = useState(today)
  const [selectedHistoryDate, setSelectedHistoryDate] = useState(today)

  async function load() {
    setLoading(true)
    try {
      const [s, t] = await Promise.all([
        fetch('/api/restaurant/dish-sales').then(r => r.json()),
        fetch('/api/transactions').then(r => r.json()),
      ])
      setSales(Array.isArray(s) ? s : [])
      setTxns(Array.isArray(t) ? t : Array.isArray(t?.transactions) ? t.transactions : [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function filterByPeriod<T extends { saleDate?: string; date?: string }>(items: T[]): T[] {
    const now = new Date()
    const fromDate = new Date(`${draftFrom}T00:00:00`)
    const toDate = new Date(`${draftTo}T23:59:59`)
    return items.filter(item => {
      const d = new Date((item as any).saleDate ?? (item as any).date)
      if (rangeMode === 'custom') return d >= fromDate && d <= toDate
      if (period === 'today') return d.toDateString() === now.toDateString()
      if (period === 'week') {
        const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7)
        return d >= weekAgo
      }
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    })
  }

  const filteredSales = filterByPeriod(sales)
  const filteredTxns  = filterByPeriod(txns.map(t => ({ ...t, saleDate: t.date })))
  const totalSales    = filteredSales.reduce((s, i) => s + i.totalSaleAmount, 0)
  const groupedDates = Array.from(new Set(filteredSales.map(s => s.saleDate.slice(0, 10)).concat(filteredTxns.map(t => t.date.slice(0, 10))))).sort()

  useEffect(() => {
    if (groupedDates.length === 0) {
      setSelectedHistoryDate(today)
      return
    }
    setSelectedHistoryDate(current => groupedDates.includes(current) ? current : groupedDates[groupedDates.length - 1])
  }, [groupedDates, today])

  const dailyRows = groupedDates.map(date => ({
    date,
    count: filteredSales.filter(item => item.saleDate.slice(0, 10) === date).length
      + filteredTxns.filter(item => item.date.slice(0, 10) === date).length,
  }))
  const visibleSales = filteredSales.filter(item => item.saleDate.slice(0, 10) === selectedHistoryDate)
  const visibleTxns = filteredTxns.filter(item => item.date.slice(0, 10) === selectedHistoryDate)

  const applyPreset = (nextPeriod: 'today' | 'week' | 'month') => {
    setRangeMode('preset')
    setPeriod(nextPeriod)
  }

  const applyCustomRange = () => {
    if (!draftFrom || !draftTo) return
    if (draftFrom > draftTo) return
    setRangeMode('custom')
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-800">My History</h2>
        <div className="flex items-center gap-2">
          <button onClick={onAskJesse} className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-orange-300 text-orange-600 bg-white hover:bg-orange-50 transition-colors">
            <Sparkles className="h-3.5 w-3.5" /> Ask Jesse AI
          </button>
          <button onClick={load} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 bg-white hover:bg-gray-50 transition-colors">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* Period selector */}
      <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {(['today', 'week', 'month'] as const).map(p => (
          <button key={p} onClick={() => applyPreset(p)} className={rangeMode === 'preset' && period === p ? 'px-4 py-1.5 rounded-lg text-sm font-medium bg-white shadow text-gray-900 capitalize' : 'px-4 py-1.5 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-700 capitalize'}>
            {p === 'today' ? 'Today' : p === 'week' ? 'This Week' : 'This Month'}
          </button>
        ))}
        <div className={`flex items-center gap-1.5 rounded-xl border px-2 py-1 ${rangeMode === 'custom' ? 'border-orange-300 bg-orange-50' : 'border-gray-200 bg-white'}`}>
          <input type="date" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} className="bg-transparent text-xs outline-none text-gray-600" />
          <span className="text-xs text-gray-400">to</span>
          <input type="date" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} className="bg-transparent text-xs outline-none text-gray-600" />
          <button onClick={applyCustomRange} className="inline-flex items-center gap-1 rounded-md bg-gray-900 px-2 py-1 text-[11px] font-semibold text-white hover:bg-black">
            <CalendarRange className="h-3 w-3" />
            Apply
          </button>
        </div>
      </div>
      {dailyRows.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {dailyRows.map((row) => {
            const chip = dayChip(row.date)
            const isSelected = row.date === selectedHistoryDate
            return (
              <button
                key={row.date}
                onClick={() => setSelectedHistoryDate(row.date)}
                className={`min-w-[122px] rounded-xl border px-4 py-3 text-left transition-all ${isSelected ? 'border-orange-300 bg-orange-50 shadow-sm' : 'border-gray-200 bg-gray-50 hover:bg-gray-100'}`}
              >
                <p className={`text-xs font-semibold ${isSelected ? 'text-orange-600' : 'text-gray-500'}`}>{chip.weekday}</p>
                <p className="mt-1 text-base font-semibold text-gray-900">{chip.display}</p>
                <p className={`mt-1 text-xs ${isSelected ? 'text-orange-600' : 'text-gray-500'}`}>{row.count} {row.count === 1 ? 'entries' : 'entries'}</p>
              </button>
            )
          })}
        </div>
      ) : null}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500">Orders Served</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{visibleSales.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500">Total Revenue</p>
          <p className="text-lg font-bold text-orange-600 mt-1">{fmtRWF(visibleSales.reduce((sum, item) => sum + item.totalSaleAmount, 0))} RWF</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center col-span-2 sm:col-span-1">
          <p className="text-xs text-gray-500">Avg. Order Value</p>
          <p className="text-lg font-bold text-gray-900 mt-1">
            {visibleSales.length ? fmtRWF(visibleSales.reduce((sum, item) => sum + item.totalSaleAmount, 0) / visibleSales.length) : '0'} RWF
          </p>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        <button onClick={() => setTab('sales')} className={tab === 'sales' ? 'px-4 py-1.5 rounded-lg text-sm font-medium bg-white shadow text-gray-900' : 'px-4 py-1.5 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-700'}>
          <ShoppingBag className="h-4 w-4 inline mr-1.5" />Dish Sales
        </button>
        <button onClick={() => setTab('transactions')} className={tab === 'transactions' ? 'px-4 py-1.5 rounded-lg text-sm font-medium bg-white shadow text-gray-900' : 'px-4 py-1.5 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-700'}>
          <ArrowLeftRight className="h-4 w-4 inline mr-1.5" />Transactions
        </button>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">Loading...</div>
      ) : tab === 'sales' ? (
        visibleSales.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <ShoppingBag className="h-10 w-10 text-gray-300 mx-auto mb-3" />
            <p className="font-medium text-gray-600">No sales this period</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>{['Time', 'Dish', 'Qty', 'Amount', 'Payment'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {[...visibleSales].sort((a, b) => new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime()).map(s => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                      {new Date(s.saleDate).toLocaleTimeString('en-RW', { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">{s.dish.name}</td>
                    <td className="px-4 py-3 text-gray-600">{s.quantitySold}×</td>
                    <td className="px-4 py-3 font-semibold text-orange-700">{fmtRWF(s.totalSaleAmount)} RWF</td>
                    <td className="px-4 py-3">
                      <span className="text-xs bg-orange-50 text-orange-700 px-2 py-0.5 rounded-full font-medium">{s.paymentMethod}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        visibleTxns.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <ArrowLeftRight className="h-10 w-10 text-gray-300 mx-auto mb-3" />
            <p className="font-medium text-gray-600">No transactions this period</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>{['Date', 'Description', 'Account', 'DR', 'CR'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {[...visibleTxns].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).map(t => (
                  <tr key={t.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                      {new Date(t.date).toLocaleDateString('en-RW', { day: '2-digit', month: 'short' })}
                    </td>
                    <td className="px-4 py-3 text-gray-700 text-xs max-w-[200px] truncate">{t.description}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{t.account.name}</td>
                    <td className="px-4 py-3 text-xs font-medium text-green-700">{t.debit ? fmtRWF(t.debit) : '—'}</td>
                    <td className="px-4 py-3 text-xs font-medium text-red-600">{t.credit ? fmtRWF(t.credit) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}

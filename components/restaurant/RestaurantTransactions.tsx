'use client'

import { useState, useEffect, useCallback } from 'react'
import { Plus, ArrowDownLeft, ArrowUpRight, RefreshCw, Search, Sparkles, X, Calendar, TrendingUp, TrendingDown, Layers } from 'lucide-react'

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface Transaction {
  id: string
  date: string
  description: string
  amount: number
  type: 'debit' | 'credit'
  accountName: string
  categoryType: string
  paymentMethod: string
  pairId: string | null
  uploadId: string | null
  screenshotUrl: string | null
}

interface ManualFormState {
  date: string
  description: string
  amount: string
  direction: 'in' | 'out'
  accountName: string
  categoryType: string
  paymentMethod: string
}

function fmtRWF(n: number) {
  return `RWF ${n.toLocaleString('en-US', { minimumFractionDigits: 0 })}`
}

function todayStr(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return n + 'th'
  switch (n % 10) {
    case 1: return n + 'st'
    case 2: return n + 'nd'
    case 3: return n + 'rd'
    default: return n + 'th'
  }
}

/** Format as "Mon, 3rd Dec 2026" */
function formatDateLabel(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00')
  const dayName = d.toLocaleDateString('en-GB', { weekday: 'short' })
  const month   = d.toLocaleDateString('en-GB', { month: 'short' })
  return `${dayName}, ${ordinal(d.getDate())} ${month} ${d.getFullYear()}`
}

const CATEGORIES = ['income', 'expense', 'asset', 'liability', 'equity']
const PAYMENT_METHODS = ['Cash', 'Bank', 'Mobile Money', 'Card', 'Other']

// â”€â”€â”€ Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function RestaurantTransactions({ onAskJesse }: { onAskJesse?: () => void }) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDate, setSelectedDate] = useState<string>(todayStr())
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  const [form, setForm] = useState<ManualFormState>({
    date: todayStr(),
    description: '',
    amount: '',
    direction: 'out',
    accountName: '',
    categoryType: 'expense',
    paymentMethod: 'Cash',
  })

  // â”€â”€ Fetch â”€â”€
  const fetchTransactions = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/transactions', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to load')
      const data = await res.json()
      setTransactions(data.transactions || [])
    } catch {
      setTransactions([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchTransactions() }, [fetchTransactions])

  useEffect(() => {
    const handler = () => fetchTransactions()
    window.addEventListener('refreshTransactions', handler)
    return () => window.removeEventListener('refreshTransactions', handler)
  }, [fetchTransactions])

  // â”€â”€ Build date sidebar â”€â”€
  const today = todayStr()

  // Count unique journal entries per date (pairId = 1 entry; solo = 1 entry each)
  const entriesPerDate: Record<string, Set<string>> = {}
  for (const t of transactions) {
    const d = t.date.slice(0, 10)
    if (!entriesPerDate[d]) entriesPerDate[d] = new Set()
    entriesPerDate[d].add(t.pairId ?? t.id)
  }
  if (!entriesPerDate[today]) entriesPerDate[today] = new Set() // always show today

  const sortedDates = Object.keys(entriesPerDate).sort((a, b) => b.localeCompare(a))

  // â”€â”€ Transactions for selected date â”€â”€
  const dateTransactions = transactions.filter(t => t.date.slice(0, 10) === selectedDate)

  const seen = new Set<string>()
  const rows: Transaction[] = []
  for (const t of dateTransactions) {
    if (t.pairId) {
      if (seen.has(t.pairId)) continue
      seen.add(t.pairId)
    }
    if (search) {
      const s = search.toLowerCase()
      const matches =
        t.description.toLowerCase().includes(s) ||
        t.accountName.toLowerCase().includes(s) ||
        t.categoryType.toLowerCase().includes(s) ||
        t.paymentMethod.toLowerCase().includes(s)
      if (!matches) continue
    }
    rows.push(t)
  }

  const totalIn  = dateTransactions.filter(t => t.type === 'debit'  && t.accountName === 'Cash').reduce((s, t) => s + t.amount, 0)
  const totalOut = dateTransactions.filter(t => t.type === 'credit' && t.accountName === 'Cash').reduce((s, t) => s + t.amount, 0)

  // â”€â”€ Save manual transaction â”€â”€
  const handleSave = async () => {
    setSaveError(null)
    const amt = parseFloat(form.amount)
    if (!form.description.trim()) { setSaveError('Description is required'); return }
    if (!Number.isFinite(amt) || amt <= 0) { setSaveError('Enter a valid positive amount'); return }

    setSaving(true)
    try {
      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          date: form.date,
          description: form.description,
          amount: amt,
          direction: form.direction,
          accountName: form.accountName || undefined,
          categoryType: form.categoryType,
          paymentMethod: form.paymentMethod,
        })
      })
      if (!res.ok) {
        const msg = await res.text()
        throw new Error(msg || 'Failed to save')
      }
      setSaveSuccess(true)
      window.dispatchEvent(new Event('refreshTransactions'))
      setForm({ date: todayStr(), description: '', amount: '', direction: 'out', accountName: '', categoryType: 'expense', paymentMethod: 'Cash' })
      await fetchTransactions()
      setTimeout(() => { setSaveSuccess(false); setShowModal(false) }, 1200)
    } catch (e: any) {
      setSaveError(e?.message || 'Error saving transaction')
    } finally {
      setSaving(false)
    }
  }

  const dateLabel = selectedDate === today ? 'Today' : formatDateLabel(selectedDate)

  // â”€â”€ Render â”€â”€
  return (
    <div className="space-y-4">

      {/* â”€â”€ Jesse AI banner â”€â”€ */}
      <div className="bg-gradient-to-r from-orange-500 to-red-600 rounded-xl p-4 flex items-center justify-between gap-4 shadow-md">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-white/20 rounded-lg">
            <Sparkles className="h-5 w-5 text-white" />
          </div>
          <div>
            <p className="text-white font-semibold text-sm">Ask Jesse to record transactions</p>
            <p className="text-orange-100 text-xs mt-0.5">
              Upload a receipt or photo and say "Record this expense" â€” Jesse will do the rest.
            </p>
          </div>
        </div>
        <button
          onClick={onAskJesse}
          className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-white text-orange-600 rounded-lg text-sm font-semibold hover:bg-orange-50 transition-colors shadow"
        >
          <Sparkles className="h-4 w-4" />
          Ask Jesse
        </button>
      </div>

      {/* â”€â”€ Two-column layout â”€â”€ */}
      <div className="flex gap-4 items-start">

        {/* â”€â”€ Date sidebar â”€â”€ */}
        <div className="w-52 flex-shrink-0 bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden sticky top-4 self-start">
          <div className="px-3 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Date History</p>
            <button onClick={fetchTransactions} title="Refresh" className="p-1 rounded hover:bg-gray-200 transition-colors">
              <RefreshCw className={`h-3 w-3 text-gray-400 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 270px)' }}>
            {sortedDates.map(d => {
              const count = entriesPerDate[d]?.size ?? 0
              const isToday = d === today
              const isSelected = d === selectedDate
              return (
                <button
                  key={d}
                  onClick={() => setSelectedDate(d)}
                  className={`w-full text-left px-3 py-2.5 border-b border-gray-50 transition-colors ${
                    isSelected
                      ? 'bg-orange-50 border-l-[3px] border-l-orange-500'
                      : 'hover:bg-gray-50 border-l-[3px] border-l-transparent'
                  }`}
                >
                  {isToday ? (
                    <>
                      <p className={`text-[11px] font-bold ${isSelected ? 'text-orange-700' : 'text-gray-800'}`}>Today</p>
                      <p className={`text-[10px] mt-0.5 ${isSelected ? 'text-orange-500' : 'text-gray-400'}`}>{formatDateLabel(d)}</p>
                    </>
                  ) : (
                    <>
                      <p className={`text-[11px] font-semibold leading-snug ${isSelected ? 'text-orange-700' : 'text-gray-800'}`}>
                        {formatDateLabel(d)}
                      </p>
                    </>
                  )}
                  <p className={`text-[10px] font-medium mt-1 ${
                    count > 0
                      ? isSelected ? 'text-orange-600' : 'text-gray-500'
                      : 'text-gray-300'
                  }`}>
                    {count === 0 ? 'No entries' : `${count} ${count === 1 ? 'entry' : 'entries'}`}
                  </p>
                </button>
              )
            })}
          </div>
        </div>

        {/* â”€â”€ Main content â”€â”€ */}
        <div className="flex-1 min-w-0 space-y-4">

          {/* â”€â”€ Summary cards â”€â”€ */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
            <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 font-medium">Money In</span>
                <div className="p-1.5 bg-green-100 rounded-lg"><TrendingUp className="h-4 w-4 text-green-600" /></div>
              </div>
              <p className="text-xl font-bold text-green-600">{fmtRWF(totalIn)}</p>
              <p className="text-xs text-gray-400 mt-1">{dateLabel}</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 font-medium">Money Out</span>
                <div className="p-1.5 bg-red-100 rounded-lg"><TrendingDown className="h-4 w-4 text-red-600" /></div>
              </div>
              <p className="text-xl font-bold text-red-600">{fmtRWF(totalOut)}</p>
              <p className="text-xs text-gray-400 mt-1">{dateLabel}</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 font-medium">Net</span>
                <div className="p-1.5 bg-orange-100 rounded-lg"><Layers className="h-4 w-4 text-orange-600" /></div>
              </div>
              <p className={`text-xl font-bold ${totalIn - totalOut >= 0 ? 'text-orange-600' : 'text-red-600'}`}>
                {fmtRWF(Math.abs(totalIn - totalOut))}
              </p>
              <p className="text-xs text-gray-400 mt-1">{totalIn - totalOut >= 0 ? 'Positive' : 'Negative'}</p>
            </div>
          </div>

          {/* â”€â”€ Controls â”€â”€ */}
          <div className="bg-white rounded-xl border border-gray-100 px-4 py-3 shadow-sm flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-gray-800">{dateLabel}</p>
              <p className="text-xs text-gray-400">{rows.length} {rows.length === 1 ? 'entry' : 'entries'}</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Searchâ€¦"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm w-36 focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>
              <button
                onClick={() => { setSaveError(null); setSaveSuccess(false); setShowModal(true) }}
                className="flex items-center gap-2 px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-semibold hover:bg-orange-600 transition-colors shadow-sm"
              >
                <Plus className="h-4 w-4" />
                New
              </button>
            </div>
          </div>

          {/* â”€â”€ Transactions table â”€â”€ */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <RefreshCw className="h-6 w-6 text-gray-400 animate-spin mr-2" />
                <span className="text-gray-400 text-sm">Loading transactionsâ€¦</span>
              </div>
            ) : rows.length === 0 ? (
              <div className="text-center py-16">
                <Calendar className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 font-medium">No transactions found</p>
                <p className="text-gray-400 text-sm mt-1">
                  {search ? 'Try a different search term' : `No entries recorded on ${dateLabel}`}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Description</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Account</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Category</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Method</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Amount</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Source</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {rows.map(t => {
                      const isIn = t.type === 'debit' && t.accountName === 'Cash'
                      const isCashOut = t.type === 'credit' && t.accountName === 'Cash'
                      return (
                        <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 text-gray-800 font-medium max-w-xs truncate" title={t.description}>
                            {t.description}
                          </td>
                          <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{t.accountName}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
                              t.categoryType === 'income'    ? 'bg-green-100 text-green-700'   :
                              t.categoryType === 'expense'   ? 'bg-red-100 text-red-700'        :
                              t.categoryType === 'asset'     ? 'bg-orange-100 text-orange-700'  :
                              t.categoryType === 'liability' ? 'bg-yellow-100 text-yellow-700'  :
                              'bg-gray-100 text-gray-600'
                            }`}>
                              {t.categoryType}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{t.paymentMethod}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                              t.type === 'debit' ? 'bg-orange-100 text-orange-700' : 'bg-red-100 text-red-700'
                            }`}>
                              {t.type === 'debit' ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                              {t.type === 'debit' ? 'DR' : 'CR'}
                            </span>
                          </td>
                          <td className={`px-4 py-3 font-semibold text-right whitespace-nowrap ${
                            isIn ? 'text-green-600' : isCashOut ? 'text-red-600' : 'text-gray-700'
                          }`}>
                            {isIn ? '+' : isCashOut ? '-' : ''}{fmtRWF(t.amount)}
                          </td>
                          <td className="px-4 py-3">
                            {t.uploadId
                              ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-600">Upload</span>
                              : <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Manual</span>
                            }
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50 text-xs text-gray-400">
                  {rows.length} {rows.length === 1 ? 'entry' : 'entries'} Â· {dateLabel}
                  {search && ` Â· filtered by "${search}"`}
                </div>
              </div>
            )}
          </div>

        </div>{/* end main content */}
      </div>{/* end two-column */}

      {/* â”€â”€ New Transaction Modal â”€â”€ */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 z-10">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-gray-900">New Transaction</h2>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>

            <div className="flex rounded-xl overflow-hidden border border-gray-200 mb-4">
              <button
                onClick={() => setForm(f => ({ ...f, direction: 'in', categoryType: 'income' }))}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold transition-all ${
                  form.direction === 'in' ? 'bg-green-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                <ArrowDownLeft className="h-4 w-4" /> Money In
              </button>
              <button
                onClick={() => setForm(f => ({ ...f, direction: 'out', categoryType: 'expense' }))}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold transition-all ${
                  form.direction === 'out' ? 'bg-red-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                <ArrowUpRight className="h-4 w-4" /> Money Out
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Date</label>
                <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Description *</label>
                <input type="text" placeholder="e.g. Food supplies purchase" value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Amount (RWF) *</label>
                <input type="number" placeholder="0" min="0" step="1" value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Account Name</label>
                <input type="text" placeholder={form.direction === 'in' ? 'e.g. Sales, Revenue' : 'e.g. Rent, Utilities'}
                  value={form.accountName} onChange={e => setForm(f => ({ ...f, accountName: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Category</label>
                  <select value={form.categoryType} onChange={e => setForm(f => ({ ...f, categoryType: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white capitalize">
                    {CATEGORIES.map(c => <option key={c} value={c} className="capitalize">{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Payment Method</label>
                  <select value={form.paymentMethod} onChange={e => setForm(f => ({ ...f, paymentMethod: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white">
                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {saveError && (
              <div className="mt-4 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">{saveError}</div>
            )}
            {saveSuccess && (
              <div className="mt-4 px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-sm text-green-600 font-medium">
                âœ… Transaction saved!
              </div>
            )}

            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowModal(false)}
                className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving || saveSuccess}
                className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all shadow-sm ${
                  saving || saveSuccess
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : form.direction === 'in'
                      ? 'bg-green-500 hover:bg-green-600 text-white'
                      : 'bg-red-500 hover:bg-red-600 text-white'
                }`}>
                {saving ? 'Savingâ€¦' : saveSuccess ? 'Saved!' : `Record ${form.direction === 'in' ? 'Income' : 'Expense'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


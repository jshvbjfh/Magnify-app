'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { Plus, ArrowDownLeft, ArrowUpRight, RefreshCw, Search, X, Calendar, TrendingUp, TrendingDown, Layers, Check } from 'lucide-react'
import { useRestaurantBranch } from '@/contexts/RestaurantBranchContext'
import { buildRestaurantSnapshotScope, loadRestaurantDeviceSnapshot, mergeRestaurantDeviceSnapshot } from '@/lib/restaurantDeviceSnapshot'

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
  isManual?: boolean
  sourceKind?: string | null
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

type RestaurantTransactionsSnapshot = {
  updatedAt: string
  transactions: Transaction[]
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

function isCashEquivalentAccountName(name?: string) {
  const normalized = (name ?? '').trim().toLowerCase()
  return normalized === 'cash'
    || normalized.includes('cash')
    || normalized === 'current account'
    || normalized.includes('bank')
    || normalized === 'mobile money'
    || normalized.includes('momo')
}

function isWasteLikeTransaction(transaction: Pick<Transaction, 'description' | 'sourceKind'>) {
  const normalizedSourceKind = String(transaction.sourceKind || '').trim().toLowerCase()
  if (normalizedSourceKind === 'inventory_waste') return true
  return transaction.description.trim().toLowerCase().startsWith('waste:')
}

const CATEGORIES = ['income', 'expense', 'asset', 'liability', 'equity']
const PAYMENT_METHODS = ['Cash', 'Bank', 'Mobile Money', 'Card', 'Other']

// â”€â”€â”€ Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function RestaurantTransactions({ onAskJesse }: { onAskJesse?: () => void }) {
  const { data: session } = useSession()
  const restaurantBranch = useRestaurantBranch()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState<string>(todayStr())
  const [search, setSearch] = useState('')
  const [isAddingRow, setIsAddingRow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [snapshotUpdatedAt, setSnapshotUpdatedAt] = useState<string | null>(null)
  const [showingCachedSnapshot, setShowingCachedSnapshot] = useState(false)
  const snapshotScopeId = buildRestaurantSnapshotScope({
    restaurantId: restaurantBranch?.restaurantId ?? (session?.user as any)?.restaurantId ?? null,
    branchId: restaurantBranch?.branchId ?? (session?.user as any)?.branchId ?? null,
    fallbackUserId: session?.user?.id ?? null,
  })
  const snapshotStorageScope = snapshotScopeId ? `restaurant-transactions:${snapshotScopeId}` : null

  const persistSnapshot = useCallback((nextTransactions: Transaction[]) => {
    if (!snapshotStorageScope) return
    const snapshot = mergeRestaurantDeviceSnapshot<RestaurantTransactionsSnapshot>(snapshotStorageScope, {
      transactions: nextTransactions,
    })
    if (!snapshot) return
    setSnapshotUpdatedAt(snapshot.updatedAt)
    setShowingCachedSnapshot(false)
  }, [snapshotStorageScope])

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
    setLoading(transactions.length === 0)
    setLoadError(null)

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (transactions.length === 0) {
        setLoadError('You are offline. Reconnect to load transactions from the server.')
      }
      setLoading(false)
      return
    }

    try {
      const res = await fetch('/api/transactions', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to load transactions')
      const data = await res.json()
      const nextTransactions = data.transactions || []
      setTransactions(nextTransactions)
      persistSnapshot(nextTransactions)
    } catch {
      setLoadError('Could not load transactions. Check connection or database status.')
    } finally {
      setLoading(false)
    }
  }, [persistSnapshot, transactions.length])

  useEffect(() => {
    if (!snapshotStorageScope) return

    const snapshot = loadRestaurantDeviceSnapshot<RestaurantTransactionsSnapshot>(snapshotStorageScope)
    if (!snapshot) return

    setTransactions(Array.isArray(snapshot.transactions) ? snapshot.transactions : [])
    setSnapshotUpdatedAt(snapshot.updatedAt ?? null)
    setShowingCachedSnapshot(true)
    setLoading(false)
  }, [snapshotStorageScope])

  useEffect(() => { fetchTransactions() }, [fetchTransactions])

  useEffect(() => {
    const handler = () => fetchTransactions()
    const onlineHandler = () => fetchTransactions()
    window.addEventListener('refreshTransactions', handler)
    window.addEventListener('online', onlineHandler)
    return () => {
      window.removeEventListener('refreshTransactions', handler)
      window.removeEventListener('online', onlineHandler)
    }
  }, [fetchTransactions])

  // Auto-refresh every 30 s so the tab never shows stale data after Jesse records
  useEffect(() => {
    const id = setInterval(() => fetchTransactions(), 30_000)
    return () => clearInterval(id)
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

  const totalIn  = dateTransactions.filter(t => !isWasteLikeTransaction(t) && t.type === 'debit'  && isCashEquivalentAccountName(t.accountName)).reduce((s, t) => s + t.amount, 0)
  const totalOut = dateTransactions.filter(t => !isWasteLikeTransaction(t) && t.type === 'credit' && isCashEquivalentAccountName(t.accountName)).reduce((s, t) => s + t.amount, 0)

  const openAddRow = () => {
    setSaveError(null)
    setSaveSuccess(false)
    setIsAddingRow(true)
    setForm({ date: todayStr(), description: '', amount: '', direction: 'out', accountName: '', categoryType: 'expense', paymentMethod: 'Cash' })
  }

  const cancelAddRow = () => {
    setIsAddingRow(false)
    setSaveError(null)
    setSaveSuccess(false)
    setForm({ date: todayStr(), description: '', amount: '', direction: 'out', accountName: '', categoryType: 'expense', paymentMethod: 'Cash' })
  }

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void handleSave()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelAddRow()
    }
  }

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
      window.dispatchEvent(new Event('refreshTransactions'))
      setForm({ date: todayStr(), description: '', amount: '', direction: 'out', accountName: '', categoryType: 'expense', paymentMethod: 'Cash' })
      await fetchTransactions()
      setSaveSuccess(true)
      setIsAddingRow(false)
      setTimeout(() => { setSaveSuccess(false) }, 1200)
    } catch (e: any) {
      setSaveError(e?.message || 'Error saving transaction')
    } finally {
      setSaving(false)
    }
  }

  const dateLabel = selectedDate === today ? 'Today' : formatDateLabel(selectedDate)
  const snapshotUpdatedLabel = snapshotUpdatedAt
    ? new Date(snapshotUpdatedAt).toLocaleString('en-RW', { dateStyle: 'medium', timeStyle: 'short' })
    : null

  // â”€â”€ Render â”€â”€
  return (
    <div className="space-y-4">
      {showingCachedSnapshot && snapshotUpdatedLabel ? (
        <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-semibold">Showing last synced transactions snapshot from this device</p>
          <p className="mt-1 text-xs opacity-90">Last synced snapshot: {snapshotUpdatedLabel}</p>
        </div>
      ) : null}

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

          {loadError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {loadError}
            </div>
          )}

          {/* â”€â”€ Summary cards â”€â”€ */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
            <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 font-medium">Revenue</span>
                <div className="p-1.5 bg-green-100 rounded-lg"><TrendingUp className="h-4 w-4 text-green-600" /></div>
              </div>
              <p className="text-xl font-bold text-green-600">{fmtRWF(totalIn)}</p>
              <p className="text-xs text-gray-400 mt-1">{dateLabel}</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 font-medium">Expenses</span>
                <div className="p-1.5 bg-red-100 rounded-lg"><TrendingDown className="h-4 w-4 text-red-600" /></div>
              </div>
              <p className="text-xl font-bold text-red-600">{fmtRWF(totalOut)}</p>
              <p className="text-xs text-gray-400 mt-1">{dateLabel}</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 font-medium">Profit / Loss</span>
                <div className="p-1.5 bg-orange-100 rounded-lg"><Layers className="h-4 w-4 text-orange-600" /></div>
              </div>
              <p className={`text-xl font-bold ${totalIn - totalOut >= 0 ? 'text-orange-600' : 'text-red-600'}`}>
                {fmtRWF(Math.abs(totalIn - totalOut))}
              </p>
              <p className="text-xs text-gray-400 mt-1">{totalIn - totalOut >= 0 ? 'Profitable' : 'Loss recorded'}</p>
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
                onClick={openAddRow}
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
            ) : loadError ? (
              <div className="text-center py-16">
                <Calendar className="h-10 w-10 text-red-200 mx-auto mb-3" />
                <p className="text-red-600 font-medium">Transactions unavailable</p>
                <p className="text-red-400 text-sm mt-1">The list could not be loaded from the server.</p>
              </div>
            ) : rows.length === 0 && !isAddingRow ? (
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
                    {isAddingRow && (
                      <tr className="bg-orange-50">
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={form.description}
                            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                            onKeyDown={handleRowKeyDown}
                            placeholder="Description"
                            className="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={form.accountName}
                            onChange={e => setForm(f => ({ ...f, accountName: e.target.value }))}
                            onKeyDown={handleRowKeyDown}
                            placeholder={form.direction === 'in' ? 'Sales, Revenue' : 'Rent, Utilities'}
                            className="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={form.categoryType}
                            onChange={e => setForm(f => ({ ...f, categoryType: e.target.value }))}
                            onKeyDown={handleRowKeyDown}
                            className="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
                          >
                            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={form.paymentMethod}
                            onChange={e => setForm(f => ({ ...f, paymentMethod: e.target.value }))}
                            onKeyDown={handleRowKeyDown}
                            className="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
                          >
                            {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex rounded-lg overflow-hidden border border-orange-200 bg-white">
                            <button
                              type="button"
                              onClick={() => setForm(f => ({ ...f, direction: 'in', categoryType: 'income' }))}
                              className={`flex-1 px-2 py-2 text-xs font-semibold transition-colors ${form.direction === 'in' ? 'bg-green-500 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                            >
                              In
                            </button>
                            <button
                              type="button"
                              onClick={() => setForm(f => ({ ...f, direction: 'out', categoryType: 'expense' }))}
                              className={`flex-1 px-2 py-2 text-xs font-semibold transition-colors ${form.direction === 'out' ? 'bg-red-500 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                            >
                              Out
                            </button>
                          </div>
                          <input
                            type="date"
                            value={form.date}
                            onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                            onKeyDown={handleRowKeyDown}
                            className="mt-2 w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={form.amount}
                            onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                            onKeyDown={handleRowKeyDown}
                            placeholder="0"
                            className="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-right text-sm outline-none focus:ring-2 focus:ring-orange-200"
                          />
                          {saveError && <p className="mt-1 text-[11px] font-medium text-red-600">{saveError}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={() => void handleSave()} disabled={saving} className="text-orange-600 transition-colors hover:text-orange-700 disabled:opacity-50">
                              <Check className="h-4 w-4" />
                            </button>
                            <button type="button" onClick={cancelAddRow} className="text-gray-500 transition-colors hover:text-gray-700">
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {rows.map(t => {
                      const isWasteEntry = isWasteLikeTransaction(t)
                      const isIn = !isWasteEntry && t.type === 'debit' && isCashEquivalentAccountName(t.accountName)
                      const isCashOut = !isWasteEntry && t.type === 'credit' && isCashEquivalentAccountName(t.accountName)
                      const originLabel = isWasteEntry ? 'Inventory Loss' : t.uploadId ? 'Upload' : t.isManual ? 'Manual' : 'Recorded'
                      const originClass = isWasteEntry
                        ? 'bg-amber-100 text-amber-700'
                        : t.uploadId
                          ? 'bg-orange-100 text-orange-600'
                          : t.isManual
                            ? 'bg-gray-100 text-gray-500'
                            : 'bg-emerald-100 text-emerald-700'
                      return (
                        <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 text-gray-800 font-medium max-w-xs truncate" title={t.description}>
                            {t.description}
                          </td>
                          <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{t.accountName}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
                              isWasteEntry                   ? 'bg-amber-100 text-amber-700'    :
                              t.categoryType === 'income'    ? 'bg-green-100 text-green-700'    :
                              t.categoryType === 'expense'   ? 'bg-red-100 text-red-700'       :
                              t.categoryType === 'asset'     ? 'bg-orange-100 text-orange-700' :
                              t.categoryType === 'liability' ? 'bg-yellow-100 text-yellow-700' :
                              'bg-gray-100 text-gray-600'
                            }`}>
                              {isWasteEntry ? 'inventory loss' : t.categoryType}
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
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${originClass}`}>{originLabel}</span>
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
    </div>
  )
}


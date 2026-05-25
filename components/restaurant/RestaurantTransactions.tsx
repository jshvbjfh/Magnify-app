'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { Plus, ArrowDownLeft, ArrowUpRight, RefreshCw, Search, X, Calendar, TrendingUp, TrendingDown, Layers, Check } from 'lucide-react'
import { useRestaurantBranch, BranchBadge } from '@/contexts/RestaurantBranchContext'
import { buildRestaurantSnapshotScope, loadRestaurantDeviceSnapshot, mergeRestaurantDeviceSnapshot } from '@/lib/restaurantDeviceSnapshot'

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface Transaction {
  id: string
  date: string
  createdAt?: string
  description: string
  amount: number
  direction: 'in' | 'out'
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

interface ModalFormState {
  direction: 'in' | 'out' | 'opening'
  amount: string
  description: string
  date: string
  categoryType: string
  accountName: string
  paymentMethod: string
  vatEnabled: boolean
  discountEnabled: boolean
  discountPct: string
  clientName: string
}

type RestaurantTransactionsSnapshot = {
  updatedAt: string
  transactions: Transaction[]
}

function fmtRWF(n: number) {
  return `RWF ${n.toLocaleString('en-US', { minimumFractionDigits: 0 })}`
}

function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date())
}

function toKigaliDateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(date)
}

function formatRecordedTime(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return '--'
  return new Intl.DateTimeFormat('en-RW', {
    timeZone: 'Africa/Kigali',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatRecordedDateTime(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Unknown time'
  return new Intl.DateTimeFormat('en-RW', {
    timeZone: 'Africa/Kigali',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
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

function normalizeTransactionDirection(transaction: Partial<Transaction>) {
  if (transaction.direction === 'in' || transaction.direction === 'out') return transaction.direction
  return transaction.type === 'credit' ? 'in' : 'out'
}

function normalizeTransactionType(transaction: Partial<Transaction>) {
  if (transaction.type === 'debit' || transaction.type === 'credit') return transaction.type
  return normalizeTransactionDirection(transaction) === 'in' ? 'credit' : 'debit'
}

function normalizeTransaction(row: Partial<Transaction>): Transaction {
  return {
    id: String(row.id ?? ''),
    date: String(row.date ?? new Date().toISOString()),
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : undefined,
    description: String(row.description ?? ''),
    amount: typeof row.amount === 'number' ? row.amount : Number(row.amount ?? 0),
    direction: normalizeTransactionDirection(row),
    type: normalizeTransactionType(row),
    accountName: String(row.accountName ?? ''),
    categoryType: String(row.categoryType ?? ''),
    paymentMethod: typeof row.paymentMethod === 'string' ? row.paymentMethod : '',
    pairId: typeof row.pairId === 'string' ? row.pairId : null,
    isManual: Boolean(row.isManual),
    sourceKind: typeof row.sourceKind === 'string' ? row.sourceKind : null,
    uploadId: typeof row.uploadId === 'string' ? row.uploadId : null,
    screenshotUrl: typeof row.screenshotUrl === 'string' ? row.screenshotUrl : null,
  }
}

function normalizeTransactions(rows: Partial<Transaction>[]) {
  return rows.map(normalizeTransaction)
}

function normalizeCategoryType(categoryType?: string) {
  return String(categoryType ?? '').trim().toLowerCase()
}

function isWasteLikeTransaction(transaction: Pick<Transaction, 'description' | 'sourceKind'>) {
  const normalizedSourceKind = String(transaction.sourceKind || '').trim().toLowerCase()
  if (normalizedSourceKind === 'inventory_waste') return true
  return transaction.description.trim().toLowerCase().startsWith('waste:')
}

const CATEGORIES = ['income', 'expense', 'asset', 'liability', 'equity']
const PAYMENT_METHODS = ['Cash', 'Mobile Money', 'Bank', 'Card', 'Credit', 'Owner Momo']

const DEFAULT_MODAL_FORM: ModalFormState = {
  direction: 'out',
  amount: '',
  description: '',
  date: todayStr(),
  categoryType: 'expense',
  accountName: '',
  paymentMethod: 'Cash',
  vatEnabled: false,
  discountEnabled: false,
  discountPct: '',
  clientName: '',
}

// â”€â”€â”€ Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function RestaurantTransactions({ onAskJesse }: { onAskJesse?: () => void }) {
  const { data: session } = useSession()
  const restaurantBranch = useRestaurantBranch()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState<string>(todayStr())
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [snapshotUpdatedAt, setSnapshotUpdatedAt] = useState<string | null>(null)
  const [showingCachedSnapshot, setShowingCachedSnapshot] = useState(false)
  const [modalForm, setModalForm] = useState<ModalFormState>({ ...DEFAULT_MODAL_FORM, date: todayStr() })
  const initializedSelectedDateRef = useRef(false)
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

  //â”€â”€ Fetch â”€â”€
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
      const nextTransactions = normalizeTransactions(data.transactions || [])
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

    setTransactions(Array.isArray(snapshot.transactions) ? normalizeTransactions(snapshot.transactions) : [])
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
    const d = toKigaliDateKey(t.date)
    if (!entriesPerDate[d]) entriesPerDate[d] = new Set()
    entriesPerDate[d].add(t.pairId ?? t.id)
  }
  if (!entriesPerDate[today]) entriesPerDate[today] = new Set() // always show today

  const sortedDates = Object.keys(entriesPerDate).sort((a, b) => b.localeCompare(a))
  const firstDateWithEntries = sortedDates.find((dateKey) => (entriesPerDate[dateKey]?.size ?? 0) > 0) ?? today

  useEffect(() => {
    if (initializedSelectedDateRef.current || loading) return

    if ((entriesPerDate[selectedDate]?.size ?? 0) === 0 && firstDateWithEntries !== selectedDate) {
      setSelectedDate(firstDateWithEntries)
    }

    initializedSelectedDateRef.current = true
  }, [entriesPerDate, firstDateWithEntries, loading, selectedDate])

  // â”€â”€ Transactions for selected date â”€â”€
  const dateTransactions = transactions.filter(t => toKigaliDateKey(t.date) === selectedDate)

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

  const totalRevenue = dateTransactions
    .filter((transaction) => !isWasteLikeTransaction(transaction) && normalizeCategoryType(transaction.categoryType) === 'income' && transaction.direction === 'in')
    .reduce((sum, transaction) => sum + transaction.amount, 0)
  const totalExpenses = dateTransactions
    .filter((transaction) => !isWasteLikeTransaction(transaction) && normalizeCategoryType(transaction.categoryType) === 'expense' && transaction.direction === 'out')
    .reduce((sum, transaction) => sum + transaction.amount, 0)
  const hasEntriesOnOtherDates = sortedDates.some((dateKey) => dateKey !== selectedDate && (entriesPerDate[dateKey]?.size ?? 0) > 0)

  const openModal = () => {
    setSaveError(null)
    setSaveSuccess(false)
    setModalForm({ ...DEFAULT_MODAL_FORM, date: todayStr() })
    setShowModal(true)
  }

  const closeModal = () => {
    setShowModal(false)
    setSaveError(null)
  }

  const handleCategoryChange = (nextCategoryType: string) => {
    setModalForm(prev => ({
      ...prev,
      categoryType: nextCategoryType,
      direction:
        nextCategoryType === 'income' ? 'in'
        : nextCategoryType === 'expense' ? 'out'
        : prev.direction === 'opening' ? 'in' : prev.direction,
    }))
  }

  // ── Save manual transaction ──
  const handleModalSave = async () => {
    setSaveError(null)
    const amt = parseFloat(modalForm.amount)
    if (!modalForm.description.trim()) { setSaveError('Description is required'); return }
    if (!Number.isFinite(amt) || amt <= 0) { setSaveError('Enter a valid positive amount'); return }

    const discountPct = modalForm.discountEnabled ? parseFloat(modalForm.discountPct) || 0 : 0

    setSaving(true)
    try {
      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          date: modalForm.date,
          description: modalForm.description,
          amount: amt,
          direction: modalForm.direction,
          accountName: modalForm.direction !== 'opening' ? (modalForm.accountName || undefined) : undefined,
          categoryType: modalForm.direction !== 'opening' ? modalForm.categoryType : 'equity',
          paymentMethod: modalForm.paymentMethod,
          vatEnabled: modalForm.vatEnabled && modalForm.direction === 'in',
          discount: discountPct,
          clientName: modalForm.paymentMethod === 'Credit' && modalForm.direction === 'in'
            ? modalForm.clientName : '',
        }),
      })
      if (!res.ok) {
        const msg = await res.text()
        throw new Error(msg || 'Failed to save')
      }
      window.dispatchEvent(new Event('refreshTransactions'))
      await fetchTransactions()
      setSaveSuccess(true)
      setShowModal(false)
      setTimeout(() => setSaveSuccess(false), 2000)
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
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-bold text-gray-800">Transactions</h2>
        <BranchBadge />
      </div>
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
              <p className="text-xl font-bold text-green-600">{fmtRWF(totalRevenue)}</p>
              <p className="text-xs text-gray-400 mt-1">{dateLabel}</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 font-medium">Expenses</span>
                <div className="p-1.5 bg-red-100 rounded-lg"><TrendingDown className="h-4 w-4 text-red-600" /></div>
              </div>
              <p className="text-xl font-bold text-red-600">{fmtRWF(totalExpenses)}</p>
              <p className="text-xs text-gray-400 mt-1">{dateLabel}</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 font-medium">Profit / Loss</span>
                <div className="p-1.5 bg-orange-100 rounded-lg"><Layers className="h-4 w-4 text-orange-600" /></div>
              </div>
              <p className={`text-xl font-bold ${totalRevenue - totalExpenses >= 0 ? 'text-orange-600' : 'text-red-600'}`}>
                {fmtRWF(Math.abs(totalRevenue - totalExpenses))}
              </p>
              <p className="text-xs text-gray-400 mt-1">{totalRevenue - totalExpenses >= 0 ? 'Profitable' : 'Loss recorded'}</p>
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
                onClick={openModal}
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
            ) : rows.length === 0 ? (
              <div className="text-center py-16">
                <Calendar className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 font-medium">No transactions found</p>
                <p className="text-gray-400 text-sm mt-1">
                  {search
                    ? 'Try a different search term'
                    : hasEntriesOnOtherDates
                      ? `No entries recorded on ${dateLabel}. Select another date from the history.`
                      : `No entries recorded on ${dateLabel}`}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Time</th>
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
                      const isWasteEntry = isWasteLikeTransaction(t)
                      const isRevenueEntry = !isWasteEntry && normalizeCategoryType(t.categoryType) === 'income' && t.direction === 'in'
                      const isExpenseEntry = !isWasteEntry && normalizeCategoryType(t.categoryType) === 'expense' && t.direction === 'out'
                      const originLabel = isWasteEntry ? 'Inventory Loss' : t.uploadId ? 'Upload' : t.isManual ? 'Manual' : 'Recorded'
                      const originClass = isWasteEntry
                        ? 'bg-amber-100 text-amber-700'
                        : t.uploadId
                          ? 'bg-orange-100 text-orange-600'
                          : t.isManual
                            ? 'bg-gray-100 text-gray-500'
                            : 'bg-emerald-100 text-emerald-700'
                      const recordedAt = t.createdAt ?? t.date
                      return (
                        <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 text-xs font-medium text-gray-500 whitespace-nowrap" title={formatRecordedDateTime(recordedAt)}>
                            {formatRecordedTime(recordedAt)}
                          </td>
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
                            isRevenueEntry ? 'text-green-600' : isExpenseEntry ? 'text-red-600' : 'text-gray-700'
                          }`}>
                            {isRevenueEntry ? '+' : isExpenseEntry ? '-' : ''}{fmtRWF(t.amount)}
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

      {/* ── Add Transaction Modal ── */}
      {showModal && (() => {
        const amt = parseFloat(modalForm.amount) || 0
        const discountPct = modalForm.discountEnabled ? parseFloat(modalForm.discountPct) || 0 : 0
        const effectiveAmt = discountPct > 0 ? Math.round(amt * (1 - discountPct / 100)) : amt
        const vatAmt = Math.round(effectiveAmt * 0.18)
        const totalFromCustomer = effectiveAmt + vatAmt

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/50" onClick={closeModal} />
            <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                <h3 className="text-base font-bold text-gray-900">Add Transaction</h3>
                <button onClick={closeModal} className="p-1 rounded-lg hover:bg-gray-100 transition-colors">
                  <X className="h-5 w-5 text-gray-500" />
                </button>
              </div>

              <div className="px-6 py-5 space-y-5">
                {/* Transaction type */}
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { dir: 'out' as const,      cat: 'expense', emoji: '💸', label: 'Money Out', sub: 'Expense',  active: 'border-red-500 bg-red-50 text-red-700' },
                    { dir: 'in' as const,       cat: 'income',  emoji: '💰', label: 'Money In',  sub: 'Income',   active: 'border-green-500 bg-green-50 text-green-700' },
                    { dir: 'opening' as const,  cat: 'equity',  emoji: '🏦', label: 'Opening',   sub: 'Equity',   active: 'border-blue-500 bg-blue-50 text-blue-700' },
                  ] as const).map(btn => (
                    <button
                      key={btn.dir}
                      type="button"
                      onClick={() => setModalForm(f => ({
                        ...f,
                        direction: btn.dir,
                        categoryType: btn.cat,
                        accountName: btn.dir === 'opening' ? 'Opening Balance' : '',
                        vatEnabled: false,
                        discountEnabled: false,
                      }))}
                      className={`flex flex-col items-center gap-1 py-3 px-2 rounded-xl border-2 text-sm font-semibold transition-all ${
                        modalForm.direction === btn.dir
                          ? btn.active
                          : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      <span className="text-lg">{btn.emoji}</span>
                      <span>{btn.label}</span>
                      <span className="text-[10px] font-normal opacity-60">{btn.sub}</span>
                    </button>
                  ))}
                </div>

                {/* Amount */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount (RWF)</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    autoFocus
                    value={modalForm.amount}
                    onChange={e => setModalForm(f => ({ ...f, amount: e.target.value }))}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-lg font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <input
                    type="text"
                    value={modalForm.description}
                    onChange={e => setModalForm(f => ({ ...f, description: e.target.value }))}
                    placeholder={
                      modalForm.direction === 'out' ? 'e.g. Fuel, Rent, Supplies'
                      : modalForm.direction === 'in' ? 'e.g. Sales, Service fee'
                      : 'Opening Balance'
                    }
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>

                {/* Date */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                  <input
                    type="date"
                    value={modalForm.date}
                    onChange={e => setModalForm(f => ({ ...f, date: e.target.value }))}
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>

                {/* Category + Account — hidden for opening balance */}
                {modalForm.direction !== 'opening' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                      <select
                        value={modalForm.categoryType}
                        onChange={e => handleCategoryChange(e.target.value)}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                      >
                        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Account Name</label>
                      <input
                        type="text"
                        value={modalForm.accountName}
                        onChange={e => setModalForm(f => ({ ...f, accountName: e.target.value }))}
                        placeholder={modalForm.direction === 'in' ? 'Sales, Revenue…' : 'Rent, Fuel…'}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                      />
                    </div>
                  </div>
                )}

                {/* Payment Method */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Payment Method</label>
                  <div className="grid grid-cols-3 gap-2">
                    {PAYMENT_METHODS.map(pm => (
                      <button
                        key={pm}
                        type="button"
                        onClick={() => setModalForm(f => ({ ...f, paymentMethod: pm }))}
                        className={`py-2 px-2 rounded-xl border text-xs font-semibold transition-all ${
                          modalForm.paymentMethod === pm
                            ? 'border-orange-500 bg-orange-50 text-orange-700'
                            : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {pm}
                      </button>
                    ))}
                  </div>
                </div>

                {/* A/R client name — only for Credit income */}
                {modalForm.paymentMethod === 'Credit' && modalForm.direction === 'in' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Client Name (A/R)</label>
                    <input
                      type="text"
                      value={modalForm.clientName}
                      onChange={e => setModalForm(f => ({ ...f, clientName: e.target.value }))}
                      placeholder="Customer name"
                      className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                    />
                  </div>
                )}

                {/* VAT toggle — income only */}
                {modalForm.direction === 'in' && (
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={modalForm.vatEnabled}
                        onChange={e => setModalForm(f => ({ ...f, vatEnabled: e.target.checked }))}
                        className="h-4 w-4 rounded border-gray-300 accent-orange-500"
                      />
                      <span className="text-sm font-medium text-gray-700">Include VAT 18%</span>
                    </label>
                    {modalForm.vatEnabled && amt > 0 && (
                      <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm space-y-1">
                        <div className="flex justify-between text-gray-600">
                          <span>Net income</span>
                          <span className="font-medium">{fmtRWF(effectiveAmt)}</span>
                        </div>
                        <div className="flex justify-between text-gray-600">
                          <span>VAT 18%</span>
                          <span className="font-medium">{fmtRWF(vatAmt)}</span>
                        </div>
                        <div className="flex justify-between font-bold text-green-700 border-t border-green-200 pt-1">
                          <span>Customer pays</span>
                          <span>{fmtRWF(totalFromCustomer)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Discount toggle */}
                {modalForm.direction !== 'opening' && (
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={modalForm.discountEnabled}
                        onChange={e => setModalForm(f => ({ ...f, discountEnabled: e.target.checked }))}
                        className="h-4 w-4 rounded border-gray-300 accent-orange-500"
                      />
                      <span className="text-sm font-medium text-gray-700">Discount</span>
                    </label>
                    {modalForm.discountEnabled && (
                      <div className="flex items-center gap-3">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          value={modalForm.discountPct}
                          onChange={e => setModalForm(f => ({ ...f, discountPct: e.target.value }))}
                          placeholder="0"
                          className="w-24 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                        />
                        <span className="text-gray-500 text-sm">%</span>
                        {discountPct > 0 && amt > 0 && (
                          <span className="text-gray-500 text-sm">→ effective {fmtRWF(effectiveAmt)}</span>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Error */}
                {saveError && (
                  <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{saveError}</div>
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleModalSave()}
                  disabled={saving}
                  className="px-5 py-2.5 rounded-xl bg-orange-500 text-white text-sm font-semibold hover:bg-orange-600 transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Save Transaction
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Success toast */}
      {saveSuccess && (
        <div className="fixed bottom-6 right-6 z-50 bg-green-600 text-white px-5 py-3 rounded-xl shadow-lg text-sm font-semibold flex items-center gap-2">
          <Check className="h-4 w-4" />
          Transaction saved
        </div>
      )}
    </div>
  )
}


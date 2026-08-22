'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { Plus, ArrowDownLeft, ArrowUpRight, RefreshCw, Search, X, Calendar, TrendingUp, TrendingDown, Layers, Check, Trash2, AlertTriangle } from 'lucide-react'
import { fmtDesc } from '@/lib/displayId'
import { useRestaurantBranch, BranchBadge } from '@/contexts/RestaurantBranchContext'
import { buildRestaurantSnapshotScope, loadRestaurantDeviceSnapshot, mergeRestaurantDeviceSnapshot } from '@/lib/restaurantDeviceSnapshot'
import { fetchWithWakeup } from '@/lib/fetchWithWakeup'

// --- Types ---
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
  // 'order:<id>' on a settled bill, 'manual' on a typed entry. The delete
  // confirmation reads it to warn that a sale takes its whole order with it.
  reference?: string | null
  isManual?: boolean
  sourceKind?: string | null
  uploadId: string | null
  screenshotUrl: string | null
}

interface NewTxRowState {
  direction: 'in' | 'out'
  amount: string
  description: string
  date: string
  categoryType: string
  accountName: string
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
    reference: typeof row.reference === 'string' ? row.reference : null,
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

const PAYMENT_METHODS = ['Cash', 'Mobile Money', 'Bank', 'Card', 'Credit', 'Owner Momo']

const ACCOUNT_OPTIONS: Record<string, string[]> = {
  expense: ['Fuel Expense', 'Office Rent', 'Salaries & Wages', 'Utilities', 'Supplies & Materials', 'Marketing & Advertising', 'Transport & Logistics', 'Maintenance & Repairs', 'Insurance', 'Office Supplies', 'Other Expense'],
  income: ['Sales Revenue', 'Service Revenue', 'Consultation Fee', 'Commission Income', 'Other Income'],
  asset: ['Cash', 'Bank Account', 'Mobile Money', 'Inventory', 'Equipment', 'Other Asset'],
  liability: ['Accounts Payable', 'Loan Payable', 'VAT Payable', 'Other Liability'],
  equity: ["Owner's Equity", 'Retained Earnings', 'Other Equity'],
}

// --- Component ---
export default function RestaurantTransactions({ onAskJesse }: { onAskJesse?: () => void }) {
  const { data: session } = useSession()
  const restaurantBranch = useRestaurantBranch()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState<string>(todayStr())
  const [search, setSearch] = useState('')
  const [newTxRow, setNewTxRow] = useState<NewTxRowState | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [snapshotUpdatedAt, setSnapshotUpdatedAt] = useState<string | null>(null)
  const [showingCachedSnapshot, setShowingCachedSnapshot] = useState(false)
  const [salesTotals, setSalesTotals] = useState<{ revenue: number; cost: number; profit: number } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Transaction | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletedNotice, setDeletedNotice] = useState<string | null>(null)
  const initializedSelectedDateRef = useRef(false)
  const descriptionRef = useRef<HTMLInputElement>(null)

  // Sent explicitly on every read/write so the server scopes to the station shown
  // on screen right now, rather than to the session's copy — which updates in the
  // background after a station switch and can lag behind (or fail silently).
  const activeBranchId = restaurantBranch?.branchId ?? (session?.user as any)?.branchId ?? null

  const snapshotScopeId = buildRestaurantSnapshotScope({
    restaurantId: restaurantBranch?.restaurantId ?? (session?.user as any)?.restaurantId ?? null,
    branchId: activeBranchId,
    fallbackUserId: session?.user?.id ?? null,
  })
  const snapshotStorageScope = snapshotScopeId ? `restaurant-transactions:${snapshotScopeId}` : null

  // Ref so persistSnapshot stays stable — always writes to the current scope without recreating
  const snapshotStorageScopeRef = useRef<string | null>(null)
  snapshotStorageScopeRef.current = snapshotStorageScope

  const persistSnapshot = useCallback((nextTransactions: Transaction[]) => {
    const scope = snapshotStorageScopeRef.current
    if (!scope) return
    const snapshot = mergeRestaurantDeviceSnapshot<RestaurantTransactionsSnapshot>(scope, {
      transactions: nextTransactions,
    })
    if (!snapshot) return
    setSnapshotUpdatedAt(snapshot.updatedAt)
    setShowingCachedSnapshot(false)
  }, [])

  // Ref so fetchTransactions can check whether data already exists without taking
  // transactions.length as a dependency (which would cause a re-fetch on every load)
  const hasTransactionsRef = useRef(false)

  const fetchTransactions = useCallback(async () => {
    if (!hasTransactionsRef.current) setLoading(true)
    setLoadError(null)

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (!hasTransactionsRef.current) {
        setLoadError('You are offline.')
      }
      setLoading(false)
      return
    }

    try {
      const res = await fetchWithWakeup(
        activeBranchId ? `/api/transactions?branchId=${encodeURIComponent(activeBranchId)}` : '/api/transactions',
        { credentials: 'include' },
        () => setConnecting(true),
      )
      setConnecting(false)
      if (!res.ok) throw new Error('Failed to load transactions')
      const data = await res.json()
      const nextTransactions = normalizeTransactions(data.transactions || [])
      hasTransactionsRef.current = nextTransactions.length > 0
      setTransactions(nextTransactions)
      persistSnapshot(nextTransactions)
    } catch {
      setConnecting(false)
      setLoadError('Could not load transactions.')
    } finally {
      setLoading(false)
    }
  }, [persistSnapshot, activeBranchId])

  const fetchSalesTotals = useCallback(async (dateKey: string) => {
    try {
      const branchParam = activeBranchId ? `&branchId=${encodeURIComponent(activeBranchId)}` : ''
      const res = await fetch(`/api/restaurant/reports/dish-profitability?from=${dateKey}&to=${dateKey}${branchParam}`, { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to load sales totals')
      const data = await res.json()
      setSalesTotals({
        revenue: Number(data.totals?.totalRevenue ?? 0),
        cost: Number(data.totals?.totalCost ?? 0),
        profit: Number(data.totals?.totalProfit ?? 0),
      })
    } catch {
      setSalesTotals(null)
    }
  }, [activeBranchId])

  useEffect(() => {
    void fetchSalesTotals(selectedDate)
  }, [selectedDate, fetchSalesTotals])

  useEffect(() => {
    const handler = () => fetchSalesTotals(selectedDate)
    window.addEventListener('refreshTransactions', handler)
    window.addEventListener('online', handler)
    return () => {
      window.removeEventListener('refreshTransactions', handler)
      window.removeEventListener('online', handler)
    }
  }, [selectedDate, fetchSalesTotals])

  const [viewMode, setViewMode] = useState<'all' | 'grouped'>('all')
  const [dishSales, setDishSales] = useState<any[]>([])

  const fetchDishSales = useCallback(async (dateKey: string) => {
    try {
      const branchParam = activeBranchId ? `&branchId=${encodeURIComponent(activeBranchId)}` : ''
      const res = await fetch(`/api/restaurant/dish-sales?from=${dateKey}&to=${dateKey}${branchParam}`, { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to load dish sales')
      const data = await res.json()
      setDishSales(Array.isArray(data) ? data : [])
    } catch {
      setDishSales([])
    }
  }, [activeBranchId])

  useEffect(() => {
    void fetchDishSales(selectedDate)
  }, [selectedDate, fetchDishSales])

  useEffect(() => {
    const handler = () => fetchDishSales(selectedDate)
    window.addEventListener('refreshTransactions', handler)
    window.addEventListener('online', handler)
    return () => {
      window.removeEventListener('refreshTransactions', handler)
      window.removeEventListener('online', handler)
    }
  }, [selectedDate, fetchDishSales])

  const groupedDishRows = (() => {
    const map = new Map<string, { dishName: string; qty: number; amount: number }>()
    for (const sale of dishSales) {
      if (sale?.deletedAt) continue
      const key = String(sale?.dishName ?? 'Unknown')
      const qty = Number(sale?.quantitySold ?? 0)
      const amount = Number(sale?.totalSaleAmount ?? 0)
      const existing = map.get(key)
      if (existing) {
        existing.qty += qty
        existing.amount += amount
      } else {
        map.set(key, { dishName: key, qty, amount })
      }
    }
    return Array.from(map.values())
      .filter((row) => !search || row.dishName.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => b.qty - a.qty)
  })()

  useEffect(() => {
    if (!snapshotStorageScope) return
    const snapshot = loadRestaurantDeviceSnapshot<RestaurantTransactionsSnapshot>(snapshotStorageScope)
    if (!snapshot) {
      // No cache for this branch — clear stale data so the previous branch doesn't show
      setTransactions([])
      hasTransactionsRef.current = false
      return
    }
    hasTransactionsRef.current = true
    setTransactions(Array.isArray(snapshot.transactions) ? normalizeTransactions(snapshot.transactions) : [])
    setSnapshotUpdatedAt(snapshot.updatedAt ?? null)
    setShowingCachedSnapshot(true)
    setLoading(false)
  }, [snapshotStorageScope])

  // Initial fetch on mount
  useEffect(() => { fetchTransactions() }, [fetchTransactions])

  // Re-fetch when branch changes — snapshot effect shows cached data instantly,
  // this fires a background server fetch to get fresh data for the new branch
  const prevSnapshotScopeRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (prevSnapshotScopeRef.current === undefined) {
      prevSnapshotScopeRef.current = snapshotStorageScope
      return // mount fetch is handled above
    }
    if (prevSnapshotScopeRef.current !== snapshotStorageScope) {
      prevSnapshotScopeRef.current = snapshotStorageScope
      void fetchTransactions()
    }
  }, [snapshotStorageScope, fetchTransactions])

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

  useEffect(() => {
    const id = setInterval(() => fetchTransactions(), 30_000)
    return () => clearInterval(id)
  }, [fetchTransactions])

  // --- Date sidebar ---
  const today = todayStr()

  const entriesPerDate: Record<string, Set<string>> = {}
  for (const t of transactions) {
    const d = toKigaliDateKey(t.date)
    if (!entriesPerDate[d]) entriesPerDate[d] = new Set()
    entriesPerDate[d].add(t.pairId ?? t.id)
  }
  if (!entriesPerDate[today]) entriesPerDate[today] = new Set()

  const sortedDates = Object.keys(entriesPerDate).sort((a, b) => b.localeCompare(a))
  const firstDateWithEntries = sortedDates.find((dateKey) => (entriesPerDate[dateKey]?.size ?? 0) > 0) ?? today

  useEffect(() => {
    if (initializedSelectedDateRef.current || loading) return
    if ((entriesPerDate[selectedDate]?.size ?? 0) === 0 && firstDateWithEntries !== selectedDate) {
      setSelectedDate(firstDateWithEntries)
    }
    initializedSelectedDateRef.current = true
  }, [entriesPerDate, firstDateWithEntries, loading, selectedDate])

  // --- Transactions for selected date ---
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
    .filter((t) => !isWasteLikeTransaction(t) && normalizeCategoryType(t.categoryType) === 'income' && t.direction === 'in')
    .reduce((sum, t) => sum + t.amount, 0)
  const totalExpenses = dateTransactions
    .filter((t) => !isWasteLikeTransaction(t) && normalizeCategoryType(t.categoryType) === 'expense' && t.direction === 'out')
    .reduce((sum, t) => sum + t.amount, 0)
  const hasEntriesOnOtherDates = sortedDates.some((dateKey) => dateKey !== selectedDate && (entriesPerDate[dateKey]?.size ?? 0) > 0)

  // --- Row-entry actions ---
  const openNewTxRow = () => {
    setSaveError(null)
    const accounts = ACCOUNT_OPTIONS['expense'] ?? []
    setNewTxRow({
      direction: 'out',
      amount: '',
      description: '',
      date: todayStr(),
      categoryType: 'expense',
      accountName: accounts[accounts.length - 1] ?? 'Other Expense',
      paymentMethod: 'Cash',
    })
    setTimeout(() => descriptionRef.current?.focus(), 50)
  }

  const handleRowTypeChange = (type: string) => {
    const accounts = ACCOUNT_OPTIONS[type] ?? []
    const lastAccount = accounts[accounts.length - 1] ?? ''
    setNewTxRow(prev => prev ? {
      ...prev,
      categoryType: type,
      accountName: lastAccount,
      direction: type === 'income' ? 'in' : 'out',
    } : null)
  }

  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveNewTxRow(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setNewTxRow(null)
    }
  }

  const saveNewTxRow = async (keepOpen: boolean) => {
    if (!newTxRow) return
    const desc = newTxRow.description.trim()
    if (!desc) return
    const amt = parseFloat(newTxRow.amount)
    if (!Number.isFinite(amt) || amt <= 0) return

    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          direction: newTxRow.direction,
          categoryType: newTxRow.categoryType,
          accountName: newTxRow.accountName,
          description: desc,
          amount: amt,
          paymentMethod: newTxRow.paymentMethod,
          date: newTxRow.date,
          vatEnabled: false,
          discount: 0,
          branchId: activeBranchId,
        }),
      })
      if (!res.ok) {
        const msg = await res.text()
        throw new Error(msg || 'Failed to save')
      }
      window.dispatchEvent(new Event('refreshTransactions'))
      await fetchTransactions()
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
      if (keepOpen) {
        setNewTxRow(prev => prev ? { ...prev, amount: '', description: '' } : null)
        setTimeout(() => descriptionRef.current?.focus(), 50)
      } else {
        setNewTxRow(null)
      }
    } catch (e: any) {
      setSaveError(e?.message || 'Error saving transaction')
    } finally {
      setSaving(false)
    }
  }

  // A settled bill is one row here but several rows underneath — the sale, its
  // dishes, the stock they used. The confirmation has to say so before it goes.
  const pendingDeleteIsSale = Boolean(pendingDelete?.reference?.startsWith('order:'))

  const confirmDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/transactions/${encodeURIComponent(pendingDelete.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || 'Could not delete this transaction.')
      }
      // Drop it locally first so the row goes the moment it is confirmed, then
      // let the refetch below settle the totals and the cached snapshot.
      setTransactions(prev => prev.filter(t => t.id !== pendingDelete.id))
      setPendingDelete(null)
      window.dispatchEvent(new Event('refreshTransactions'))
      await fetchTransactions()
      setDeletedNotice(pendingDeleteIsSale ? 'Sale deleted' : 'Transaction deleted')
      setTimeout(() => setDeletedNotice(null), 2500)
    } catch (e: any) {
      setDeleteError(e?.message || 'Could not delete this transaction.')
    } finally {
      setDeleting(false)
    }
  }

  const dateLabel = selectedDate === today ? 'Today' : formatDateLabel(selectedDate)
  const snapshotUpdatedLabel = snapshotUpdatedAt
    ? new Date(snapshotUpdatedAt).toLocaleString('en-RW', { dateStyle: 'medium', timeStyle: 'short' })
    : null

  // --- Render ---
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

      {/* Two-column layout */}
      <div className="flex gap-4 items-start">

        {/* Date sidebar */}
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
                    <p className={`text-[11px] font-semibold leading-snug ${isSelected ? 'text-orange-700' : 'text-gray-800'}`}>
                      {formatDateLabel(d)}
                    </p>
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

        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-4">

          {connecting && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 flex items-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
              Connecting to server...
            </div>
          )}
          {loadError && hasTransactionsRef.current && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {loadError}
            </div>
          )}

          {/* Summary cards — general ledger + sales P&L, compact single row */}
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            <div className="bg-white rounded-lg border border-gray-100 p-2.5 shadow-sm">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-500 font-medium truncate">Revenue</span>
                <div className="p-1 bg-green-100 rounded-md flex-shrink-0"><TrendingUp className="h-3 w-3 text-green-600" /></div>
              </div>
              <p className="text-sm font-bold text-green-600 truncate">{fmtRWF(totalRevenue)}</p>
              <p className="text-[9px] text-gray-400 mt-0.5 truncate">General</p>
            </div>
            <div className="bg-white rounded-lg border border-gray-100 p-2.5 shadow-sm">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-500 font-medium truncate">Expenses</span>
                <div className="p-1 bg-red-100 rounded-md flex-shrink-0"><TrendingDown className="h-3 w-3 text-red-600" /></div>
              </div>
              <p className="text-sm font-bold text-red-600 truncate">{fmtRWF(totalExpenses)}</p>
              <p className="text-[9px] text-gray-400 mt-0.5 truncate">General</p>
            </div>
            <div className="bg-white rounded-lg border border-gray-100 p-2.5 shadow-sm">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-500 font-medium truncate">Profit / Loss</span>
                <div className="p-1 bg-orange-100 rounded-md flex-shrink-0"><Layers className="h-3 w-3 text-orange-600" /></div>
              </div>
              <p className={`text-sm font-bold truncate ${totalRevenue - totalExpenses >= 0 ? 'text-orange-600' : 'text-red-600'}`}>
                {fmtRWF(Math.abs(totalRevenue - totalExpenses))}
              </p>
              <p className="text-[9px] text-gray-400 mt-0.5 truncate">General</p>
            </div>
            <div className="bg-white rounded-lg border border-gray-100 p-2.5 shadow-sm">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-500 font-medium truncate">Cost of Goods</span>
                <div className="p-1 bg-red-100 rounded-md flex-shrink-0"><TrendingDown className="h-3 w-3 text-red-600" /></div>
              </div>
              <p className="text-sm font-bold text-red-600 truncate">{fmtRWF(salesTotals?.cost ?? 0)}</p>
              <p className="text-[9px] text-gray-400 mt-0.5 truncate">Sales</p>
            </div>
            <div className="bg-white rounded-lg border border-gray-100 p-2.5 shadow-sm">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-500 font-medium truncate">Sales Profit</span>
                <div className="p-1 bg-orange-100 rounded-md flex-shrink-0"><Layers className="h-3 w-3 text-orange-600" /></div>
              </div>
              <p className={`text-sm font-bold truncate ${(salesTotals?.profit ?? 0) >= 0 ? 'text-orange-600' : 'text-red-600'}`}>
                {fmtRWF(Math.abs(salesTotals?.profit ?? 0))}
              </p>
              <p className="text-[9px] text-gray-400 mt-0.5 truncate">Sales</p>
            </div>
          </div>

          {/* All / Grouped toggle */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setViewMode('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${viewMode === 'all' ? 'bg-orange-500 text-white shadow-sm' : 'bg-white border border-gray-200 text-gray-500 hover:bg-gray-50'}`}
            >
              All
            </button>
            <button
              onClick={() => setViewMode('grouped')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${viewMode === 'grouped' ? 'bg-orange-500 text-white shadow-sm' : 'bg-white border border-gray-200 text-gray-500 hover:bg-gray-50'}`}
            >
              Grouped
            </button>
          </div>

          {viewMode === 'grouped' && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-gray-800">{dateLabel}</p>
                  <p className="text-xs text-gray-400">{groupedDishRows.length} {groupedDishRows.length === 1 ? 'item' : 'items'} sold</p>
                </div>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search dish&hellip;"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm w-40 focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
              </div>
              {groupedDishRows.length === 0 ? (
                <div className="text-center py-16">
                  <Calendar className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500 font-medium">No items sold</p>
                  <p className="text-gray-400 text-sm mt-1">
                    {search ? 'Try a different search term' : `No dishes sold on ${dateLabel}`}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Dish</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Qty Sold</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Net Amount (RWF)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {groupedDishRows.map((row) => (
                        <tr key={row.dishName} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 text-gray-800 font-medium">{fmtDesc(row.dishName)}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{row.qty}</td>
                          <td className="px-4 py-3 text-right font-semibold text-green-600">{row.amount >= 0 ? '+' : '-'}{fmtRWF(Math.abs(row.amount))}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-900 text-white font-bold">
                        <td className="px-4 py-2.5 text-xs">TOTAL</td>
                        <td className="px-4 py-2.5 text-xs text-right">{groupedDishRows.reduce((s, r) => s + r.qty, 0)}</td>
                        <td className="px-4 py-2.5 text-xs text-right">{fmtRWF(groupedDishRows.reduce((s, r) => s + r.amount, 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          {viewMode === 'all' && <>
          {/* Controls */}
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
                  placeholder="Search&hellip;"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm w-36 focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>
              <button
                onClick={openNewTxRow}
                disabled={!!newTxRow}
                className="flex items-center gap-2 px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-semibold hover:bg-orange-600 transition-colors shadow-sm disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Add Transaction
              </button>
            </div>
          </div>

          {/* Transactions table */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <RefreshCw className="h-6 w-6 text-gray-400 animate-spin mr-2" />
                <span className="text-gray-400 text-sm">Loading transactions&hellip;</span>
              </div>
            ) : loadError && !hasTransactionsRef.current ? (
              <div className="text-center py-16">
                <Calendar className="h-10 w-10 text-red-200 mx-auto mb-3" />
                <p className="text-red-600 font-medium">Could not load transactions.</p>
                <p className="text-red-400 text-sm mt-1">Check your connection and try again.</p>
              </div>
            ) : rows.length === 0 && !newTxRow ? (
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
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Category / Account</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Description</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Amount (RWF)</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Received / Paid</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Time</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Source</th>
                      <th className="w-10 px-2 py-3"><span className="sr-only">Delete</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">

                    {/* Inline row-entry form */}
                    {newTxRow && (
                      <>
                        <tr className="bg-blue-50 border-t-2 border-blue-400">
                          {/* 1. Type */}
                          <td className="px-2 py-2">
                            <select
                              value={newTxRow.categoryType}
                              onChange={e => handleRowTypeChange(e.target.value)}
                              onKeyDown={handleRowKeyDown}
                              disabled={saving}
                              className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs font-medium bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 w-full"
                            >
                              {['expense', 'income', 'asset', 'liability', 'equity'].map(t => (
                                <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                              ))}
                            </select>
                          </td>
                          {/* 2. Category / Account */}
                          <td className="px-2 py-2">
                            <select
                              value={newTxRow.accountName}
                              onChange={e => setNewTxRow(prev => prev ? { ...prev, accountName: e.target.value } : null)}
                              onKeyDown={handleRowKeyDown}
                              disabled={saving}
                              className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 w-full"
                            >
                              {(ACCOUNT_OPTIONS[newTxRow.categoryType] ?? []).map(a => (
                                <option key={a} value={a}>{a}</option>
                              ))}
                            </select>
                          </td>
                          {/* 3. Description */}
                          <td className="px-2 py-2">
                            <input
                              ref={descriptionRef}
                              type="text"
                              placeholder="e.g. Paid rent for May"
                              value={newTxRow.description}
                              onChange={e => setNewTxRow(prev => prev ? { ...prev, description: e.target.value } : null)}
                              onKeyDown={handleRowKeyDown}
                              disabled={saving}
                              className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 w-full"
                            />
                          </td>
                          {/* 4. Amount */}
                          <td className="px-2 py-2">
                            <input
                              type="text"
                              inputMode="decimal"
                              placeholder="0"
                              value={newTxRow.amount}
                              onChange={e => setNewTxRow(prev => prev ? { ...prev, amount: e.target.value } : null)}
                              onKeyDown={handleRowKeyDown}
                              disabled={saving}
                              className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 w-full text-right"
                            />
                          </td>
                          {/* 5. Received / Paid */}
                          <td className="px-2 py-2">
                            <select
                              value={newTxRow.paymentMethod}
                              onChange={e => setNewTxRow(prev => prev ? { ...prev, paymentMethod: e.target.value } : null)}
                              onKeyDown={handleRowKeyDown}
                              disabled={saving}
                              className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 w-full"
                            >
                              {PAYMENT_METHODS.map(pm => <option key={pm} value={pm}>{pm}</option>)}
                            </select>
                          </td>
                          {/* 6. Date */}
                          <td className="px-2 py-2">
                            <input
                              type="date"
                              value={newTxRow.date}
                              onChange={e => setNewTxRow(prev => prev ? { ...prev, date: e.target.value } : null)}
                              onKeyDown={handleRowKeyDown}
                              disabled={saving}
                              className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 w-full"
                            />
                          </td>
                          {/* 7. Save / Discard */}
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => void saveNewTxRow(false)}
                                disabled={saving}
                                title="Save and close"
                                className="p-1.5 rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50 flex items-center"
                              >
                                {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                              </button>
                              <button
                                onClick={() => setNewTxRow(null)}
                                disabled={saving}
                                title="Discard"
                                className="p-1.5 rounded-lg bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors disabled:opacity-50"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                          <td className="px-2 py-2" />
                        </tr>
                        {/* Hints row */}
                        <tr className="bg-blue-50 border-b-2 border-blue-400">
                          <td colSpan={8} className="px-4 pb-2.5">
                            <div className="flex items-center gap-4 flex-wrap">
                              <button
                                onClick={() => void saveNewTxRow(true)}
                                disabled={saving}
                                className="text-xs text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50"
                              >
                                Save &amp; add another
                              </button>
                              <span className="text-xs text-blue-400">Enter to save &amp; continue &middot; Esc to cancel</span>
                              {saveError && (
                                <span className="text-xs text-red-600 font-medium">{saveError}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      </>
                    )}

                    {/* Transaction rows */}
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
                        <tr key={t.id} className="group hover:bg-gray-50 transition-colors">
                          {/* Type badge */}
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
                              isWasteEntry                   ? 'bg-amber-100 text-amber-700'    :
                              t.categoryType === 'income'    ? 'bg-green-100 text-green-700'    :
                              t.categoryType === 'expense'   ? 'bg-red-100 text-red-700'        :
                              t.categoryType === 'asset'     ? 'bg-orange-100 text-orange-700'  :
                              t.categoryType === 'liability' ? 'bg-yellow-100 text-yellow-700'  :
                              'bg-gray-100 text-gray-600'
                            }`}>
                              {isWasteEntry ? 'inventory loss' : t.categoryType}
                            </span>
                          </td>
                          {/* Category / Account */}
                          <td className="px-4 py-3 text-gray-600 whitespace-nowrap text-xs">{t.accountName}</td>
                          {/* Description */}
                          <td className="px-4 py-3 text-gray-800 font-medium max-w-xs truncate" title={fmtDesc(t.description)}>
                            {fmtDesc(t.description)}
                          </td>
                          {/* Amount */}
                          <td className={`px-4 py-3 font-semibold text-right whitespace-nowrap ${
                            isRevenueEntry ? 'text-green-600' : isExpenseEntry ? 'text-red-600' : 'text-gray-700'
                          }`}>
                            {isRevenueEntry ? '+' : isExpenseEntry ? '-' : ''}{fmtRWF(t.amount)}
                          </td>
                          {/* Received / Paid */}
                          <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{t.paymentMethod}</td>
                          {/* Date */}
                          <td className="px-4 py-3 text-xs font-medium text-gray-500 whitespace-nowrap" title={formatRecordedDateTime(recordedAt)}>
                            {formatRecordedTime(recordedAt)}
                          </td>
                          {/* Source */}
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${originClass}`}>{originLabel}</span>
                          </td>
                          {/* Delete */}
                          <td className="px-2 py-3 text-right">
                            <button
                              onClick={() => { setDeleteError(null); setPendingDelete(t) }}
                              title="Delete this transaction"
                              aria-label="Delete this transaction"
                              className="p-1.5 rounded-lg text-gray-300 hover:text-red-600 hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50 text-xs text-gray-400">
                  {rows.length} {rows.length === 1 ? 'entry' : 'entries'} &middot; {dateLabel}
                  {search && ` · filtered by “${search}”`}
                </div>
              </div>
            )}
          </div>
          </>}

        </div>{/* end main content */}
      </div>{/* end two-column */}

      {/* Delete confirmation — deliberately blunt: this one is not undoable */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          role="dialog"
          aria-modal="true"
          onClick={() => { if (!deleting) setPendingDelete(null) }}
        >
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3 px-5 pt-5">
              <div className="p-2 bg-red-100 rounded-lg flex-shrink-0">
                <AlertTriangle className="h-5 w-5 text-red-600" />
              </div>
              <div>
                <p className="text-base font-bold text-gray-900">Are you sure you want to delete this transaction?</p>
                <p className="mt-1 text-sm text-gray-600">This also deletes it from every report, for ever. It cannot be undone.</p>
              </div>
            </div>

            <div className="mx-5 mt-4 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
              <p className="text-sm font-semibold text-gray-800 break-words">{fmtDesc(pendingDelete.description)}</p>
              <p className="mt-0.5 text-xs text-gray-500">
                {fmtRWF(pendingDelete.amount)}
                {pendingDelete.paymentMethod ? ` · ${pendingDelete.paymentMethod}` : ''}
                {` · ${formatRecordedDateTime(pendingDelete.createdAt ?? pendingDelete.date)}`}
              </p>
            </div>

            {pendingDeleteIsSale && (
              <p className="px-5 mt-3 text-xs text-gray-500">
                The whole bill goes with it — the order, its dishes, and the stock they used comes back.
              </p>
            )}

            {deleteError && (
              <p className="px-5 mt-3 text-xs font-medium text-red-600">{deleteError}</p>
            )}

            <div className="flex items-center justify-end gap-2 px-5 py-4">
              <button
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void confirmDelete()}
                disabled={deleting}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition-colors shadow-sm disabled:opacity-50"
              >
                {deleting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {deleting ? 'Deleting…' : 'Delete for ever'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success toast */}
      {saveSuccess && (
        <div className="fixed bottom-6 right-6 z-50 bg-green-600 text-white px-5 py-3 rounded-xl shadow-lg text-sm font-semibold flex items-center gap-2">
          <Check className="h-4 w-4" />
          Transaction saved
        </div>
      )}

      {deletedNotice && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white px-5 py-3 rounded-xl shadow-lg text-sm font-semibold flex items-center gap-2">
          <Trash2 className="h-4 w-4" />
          {deletedNotice}
        </div>
      )}
    </div>
  )
}

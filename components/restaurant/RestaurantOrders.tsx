'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { Search, X, ShoppingBag, CheckCircle2, Sparkles, Receipt, CreditCard, RefreshCw, ArrowLeftRight, UtensilsCrossed, ArrowLeft, Printer, ClipboardList, Ban, CircleHelp, ChefHat, Clock, Trash2 } from 'lucide-react'
import { useRestaurantBranch } from '@/contexts/RestaurantBranchContext'
import { calculateGrossFromNet, calculateVatFromNet } from '@/lib/restaurantVat'
import { parseRestaurantBillTemplate } from '@/lib/restaurantBillTemplate'
import {
  RESTAURANT_OFFLINE_QUEUE_CHANGED_EVENT,
  enqueueRestaurantOfflineQueue,
  isLikelyOfflineError,
  isOfflineDraftOrderId,
  loadRestaurantOfflineQueue,
  projectRestaurantPendingItems,
  removeRestaurantOfflineQueueEntries,
  removeRestaurantOfflineQueueEntry,
  updateRestaurantOfflineQueueEntry,
  type RestaurantOfflinePendingItem,
  type RestaurantOfflineQueueEntry,
} from '@/lib/restaurantOfflineQueue'
import { buildRestaurantSnapshotScope, loadRestaurantDeviceSnapshot, mergeRestaurantDeviceSnapshot } from '@/lib/restaurantDeviceSnapshot'

type Dish        = { id: string; name: string; sellingPrice: number; category: string | null; isActive: boolean }
type Sale        = {
  id: string
  dish: { name: string }
  quantitySold: number
  totalSaleAmount: number
  calculatedFoodCost: number
  paymentMethod: string
  saleDate: string
  waiterName?: string | null
  orderNumber?: string | null
  tableName?: string | null
}
type Table       = { id: string; name: string; seats: number; status: string }
type PendingItem = RestaurantOfflinePendingItem

type ApprovalPayload = {
  supervisorPin: string
  reason: string
}

type OrderSummary = {
  total: number; pending: number; served: number; paid: number; canceled: number
}
type ManagerOrder = {
  id: string; orderNumber: string; tableName: string; totalAmount: number
  createdAt: string; createdByName: string
  displayStatus: 'PENDING' | 'SERVED' | 'PAID' | 'CANCELED'
  canceledByName?: string | null
  cancelReason?: string | null
  cancellationApprovedByEmployeeName?: string | null
  paymentMethod?: string | null
  timeline: string[]
  items: Array<{ id: string; dishName: string; qty: number }>
}

type RestaurantOrdersSnapshot = {
  updatedAt: string
  dishes?: Dish[]
  sales?: Sale[]
  tables?: Table[]
  pending?: PendingItem[]
  orderSummary?: OrderSummary | null
  recentOrders?: ManagerOrder[]
  billHeader?: string
}

const PAY_METHODS  = ['Cash', 'MoMo', 'Card', 'Bank Transfer']
const VAT_RATE     = 0.18
const COLOR_POOL   = [
  ['bg-rose-400',    'text-white', 'bg-rose-700'],
  ['bg-amber-400',   'text-white', 'bg-amber-700'],
  ['bg-emerald-400', 'text-white', 'bg-emerald-700'],
  ['bg-sky-400',     'text-white', 'bg-sky-700'],
  ['bg-violet-400',  'text-white', 'bg-violet-700'],
  ['bg-pink-400',    'text-white', 'bg-pink-700'],
  ['bg-orange-400',  'text-white', 'bg-orange-700'],
  ['bg-teal-400',    'text-white', 'bg-teal-700'],
  ['bg-indigo-400',  'text-white', 'bg-indigo-700'],
  ['bg-fuchsia-400', 'text-white', 'bg-fuchsia-700'],
] as const

function fmtRWF(n: number) { return n.toLocaleString('en-RW', { maximumFractionDigits: 0 }) }
function createActionId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function getTimeLabel() {
  const h = new Date().getHours()
  if (h < 11) return 'Breakfast'
  if (h < 15) return 'Lunch'
  if (h < 18) return 'Afternoon'
  return 'Dinner'
}

export default function RestaurantOrders({
  onAskJesse,
  mode = 'pos',
  onPendingCountChange,
}: {
  onAskJesse?: () => void
  mode?: 'pos' | 'bills' | 'history'
  onPendingCountChange?: (count: number) => void
}) {
  const { data: session } = useSession()
  const restaurantBranch = useRestaurantBranch()
  const [dishes,  setDishes]   = useState<Dish[]>([])
  const [sales,   setSales]    = useState<Sale[]>([])
  const [tables,  setTables]   = useState<Table[]>([])
  const [pending, setPending]  = useState<PendingItem[]>([])
  const [loading, setLoading]  = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [billHeader, setBillHeader] = useState('')
  // POS state
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [selectedTableKey, setSelectedTableKey] = useState<string>('takeaway')
  const [orderTab,         setOrderTab]         = useState<'check' | 'actions' | 'guest'>('check')
  const [searchQuery,      setSearchQuery]       = useState('')
  const [showSearch,       setShowSearch]        = useState(false)
  const [addedFlash,       setAddedFlash]        = useState(false)
  // Local cart: items tapped but not yet confirmed (per table key)
  const [localCart, setLocalCart] = useState<Record<string, {dishId:string; dishName:string; dishPrice:number; qty:number}[]>>({})
  const [waiterByTableKey, setWaiterByTableKey] = useState<Record<string, string>>({})
  // Mobile: which panel is visible ('dishes' | 'order')
  const [showPanel, setShowPanel] = useState<'dishes' | 'order'>('dishes')
  // Payment state
  const [payingTableKey, setPayingTableKey] = useState<string | null>(null)
  const [payMethod,      setPayMethod]      = useState('Cash')
  const [payingSaving,   setPayingSaving]   = useState(false)
  const [confirmingOrder, setConfirmingOrder] = useState(false)
  const [submitError,    setSubmitError]    = useState<string | null>(null)
  // When true: show empty build-mode panel even if confirmed orders exist
  const [addingNew, setAddingNew] = useState(false)
  // Manager order-history state
  const [mgmtStatus, setMgmtStatus] = useState<'ALL' | 'PENDING' | 'SERVED' | 'PAID' | 'CANCELED'>('ALL')
  const [mgmtPeriod, setMgmtPeriod] = useState<'all' | 'today' | 'week' | 'month'>('all')
  const [orderSummary, setOrderSummary] = useState<OrderSummary | null>(null)
  const [recentOrders, setRecentOrders] = useState<ManagerOrder[]>([])
  const [offlineQueueEntries, setOfflineQueueEntries] = useState<RestaurantOfflineQueueEntry[]>([])
  const [offlineQueueSyncing, setOfflineQueueSyncing] = useState(false)
  const [offlineQueueMessage, setOfflineQueueMessage] = useState<string | null>(null)
  const [snapshotUpdatedAt, setSnapshotUpdatedAt] = useState<string | null>(null)
  const [showingCachedSnapshot, setShowingCachedSnapshot] = useState(false)
  const orderSubmitLockRef = useRef(false)
  const paymentLockRef = useRef(false)
  const currentUserRole = (session?.user as any)?.role ?? 'admin'
  const isManager = currentUserRole === 'admin' || currentUserRole === 'owner'
  const canRequestCancellation = currentUserRole !== 'kitchen'
  const canMarkServed = currentUserRole === 'admin' || currentUserRole === 'owner' || currentUserRole === 'waiter'
  const snapshotScopeId = buildRestaurantSnapshotScope({
    restaurantId: restaurantBranch?.restaurantId ?? (session?.user as any)?.restaurantId ?? null,
    branchId: restaurantBranch?.branchId ?? (session?.user as any)?.branchId ?? null,
    fallbackUserId: session?.user?.id ?? null,
  })
  const snapshotStorageScope = snapshotScopeId ? `restaurant-orders:${snapshotScopeId}` : null

  const refreshOfflineQueue = useCallback(() => {
    setOfflineQueueEntries(loadRestaurantOfflineQueue())
  }, [])

  const hydrateCachedSnapshot = useCallback(() => {
    if (!snapshotStorageScope) return false

    const snapshot = loadRestaurantDeviceSnapshot<RestaurantOrdersSnapshot>(snapshotStorageScope)
    if (!snapshot) return false

    if (Array.isArray(snapshot.dishes)) setDishes(snapshot.dishes)
    if (Array.isArray(snapshot.sales)) setSales(snapshot.sales)
    if (Array.isArray(snapshot.tables)) setTables(snapshot.tables)
    if (Array.isArray(snapshot.pending)) setPending(snapshot.pending)
    if (Array.isArray(snapshot.recentOrders)) setRecentOrders(snapshot.recentOrders)
    if ('orderSummary' in snapshot) setOrderSummary(snapshot.orderSummary ?? null)
    if (typeof snapshot.billHeader === 'string') setBillHeader(snapshot.billHeader)

    setSnapshotUpdatedAt(snapshot.updatedAt ?? null)
    setShowingCachedSnapshot(true)
    setLoading(false)
    return true
  }, [snapshotStorageScope])

  const persistSnapshot = useCallback((partial: Partial<RestaurantOrdersSnapshot>) => {
    if (!snapshotStorageScope) return

    const snapshot = mergeRestaurantDeviceSnapshot<RestaurantOrdersSnapshot>(snapshotStorageScope, partial)
    if (!snapshot) return

    setSnapshotUpdatedAt(snapshot.updatedAt)
    setShowingCachedSnapshot(false)
  }, [snapshotStorageScope])

  const loadTables = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/tables-db', { credentials: 'include' })
      const data = await res.json()
      const nextTables = Array.isArray(data) ? data : []
      setTables(nextTables)
      persistSnapshot({ tables: nextTables })
    } catch {}
  }, [persistSnapshot])

  const loadPending = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/pending?includeServed=1', { credentials: 'include' })
      const data = await res.json()
      const nextPending = Array.isArray(data) ? data : []
      setPending(nextPending)
      persistSnapshot({ pending: nextPending })
    } catch {}
  }, [persistSnapshot])

  const loadSales = useCallback(async () => {
    setLoading(sales.length === 0)
    try {
      const [d, s] = await Promise.all([
        fetch('/api/restaurant/dishes').then(r=>r.json()),
        fetch('/api/restaurant/dish-sales').then(r=>r.json()),
      ])
      const nextDishes = (Array.isArray(d)?d:[]).filter((x:Dish)=>x.isActive)
      const nextSales = Array.isArray(s)?s:[]
      setDishes(nextDishes)
      setSales(nextSales)
      persistSnapshot({ dishes: nextDishes, sales: nextSales })
    } catch {}
    setLoading(false)
  }, [persistSnapshot, sales.length])

  const loadOrders = useCallback(async () => {
    try {
      const params = new URLSearchParams({ status: mgmtStatus, limit: 'all', period: mgmtPeriod })
      const res = await fetch(`/api/restaurant/orders?${params.toString()}`, { credentials: 'include' })
      if (!res.ok) return
      const payload = await res.json()
      const nextSummary = payload.summary ?? null
      const nextOrders = Array.isArray(payload.orders) ? payload.orders : []
      setOrderSummary(nextSummary)
      setRecentOrders(nextOrders)
      persistSnapshot({ orderSummary: nextSummary, recentOrders: nextOrders })
    } catch {}
  }, [mgmtStatus, mgmtPeriod, persistSnapshot])

  const flushOfflineQueue = useCallback(async () => {
    if (typeof window === 'undefined' || offlineQueueSyncing) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return

    const queuedEntries = loadRestaurantOfflineQueue()
    if (queuedEntries.length === 0) return

    setOfflineQueueSyncing(true)
    setOfflineQueueMessage(`Syncing ${queuedEntries.length} queued action${queuedEntries.length === 1 ? '' : 's'}...`)

    let processedCount = 0
    let stoppedError: string | null = null

    for (const entry of queuedEntries) {
      try {
        const res = await fetch(entry.request.url, {
          method: entry.request.method,
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(entry.request.body),
        })

        if (!res.ok) {
          const payload = await res.json().catch(() => null)
          stoppedError = payload?.error || payload?.message || `${entry.label} failed to sync`
          updateRestaurantOfflineQueueEntry(entry.id, (current) => ({
            ...current,
            attempts: current.attempts + 1,
            lastError: stoppedError,
          }))
          break
        }

        removeRestaurantOfflineQueueEntry(entry.id)
        processedCount += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Network error while syncing queued actions'
        stoppedError = message
        updateRestaurantOfflineQueueEntry(entry.id, (current) => ({
          ...current,
          attempts: current.attempts + 1,
          lastError: message,
        }))
        break
      }
    }

    refreshOfflineQueue()

    if (processedCount > 0) {
      await Promise.all([loadPending(), loadTables(), loadSales()])
      window.dispatchEvent(new CustomEvent('refreshTables'))
      window.dispatchEvent(new CustomEvent('refreshTransactions', {
        detail: { count: 2, source: 'restaurant_offline_queue_flush' },
      }))
    }

    if (stoppedError) {
      setOfflineQueueMessage(stoppedError)
    } else if (processedCount > 0) {
      setOfflineQueueMessage(`Synced ${processedCount} queued action${processedCount === 1 ? '' : 's'}.`)
    } else {
      setOfflineQueueMessage(null)
    }

    setOfflineQueueSyncing(false)
  }, [loadPending, loadSales, loadTables, offlineQueueSyncing, refreshOfflineQueue])

  useEffect(() => {
    refreshOfflineQueue()

    const queueChangedHandler = () => refreshOfflineQueue()
    const onlineHandler = () => { void flushOfflineQueue() }
    const visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        void flushOfflineQueue()
      }
    }

    window.addEventListener(RESTAURANT_OFFLINE_QUEUE_CHANGED_EVENT, queueChangedHandler)
    window.addEventListener('online', onlineHandler)
    document.addEventListener('visibilitychange', visibilityHandler)

    if (mode === 'pos' && isManager) {
      return () => {
        window.removeEventListener(RESTAURANT_OFFLINE_QUEUE_CHANGED_EVENT, queueChangedHandler)
        window.removeEventListener('online', onlineHandler)
        document.removeEventListener('visibilitychange', visibilityHandler)
      }
    }

    loadTables(); loadPending(); loadSales()
    fetch('/api/restaurant/setup', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        const nextBillHeader = data.restaurant?.billHeader ?? ''
        setBillHeader(nextBillHeader)
        persistSnapshot({ billHeader: nextBillHeader })
      })
      .catch(() => {})
    // Poll pending + tables every 5 s so the ready banner and table status stay live
    const t = setInterval(() => { loadPending(); loadTables() }, 5000)
    void flushOfflineQueue()

    return () => {
      clearInterval(t)
      window.removeEventListener(RESTAURANT_OFFLINE_QUEUE_CHANGED_EVENT, queueChangedHandler)
      window.removeEventListener('online', onlineHandler)
      document.removeEventListener('visibilitychange', visibilityHandler)
    }
  }, [flushOfflineQueue, isManager, loadTables, loadPending, loadSales, mode, persistSnapshot, refreshOfflineQueue])

  useEffect(() => {
    hydrateCachedSnapshot()
  }, [hydrateCachedSnapshot])

  // Notify parent of pending count
  const projectedPending = projectRestaurantPendingItems(pending, offlineQueueEntries)
  const snapshotUpdatedLabel = snapshotUpdatedAt
    ? new Date(snapshotUpdatedAt).toLocaleString('en-RW', { dateStyle: 'medium', timeStyle: 'short' })
    : null
  const byTable    = projectedPending.reduce<Record<string, PendingItem[]>>((a, i) => { const k = i.tableId ?? 'takeaway'; (a[k] ??= []).push(i); return a }, {})
  const activeKeys = Object.keys(byTable)
  useEffect(() => { onPendingCountChange?.(activeKeys.length) }, [activeKeys.length, onPendingCountChange])

  const todayPaid = sales.filter(s => new Date(s.saleDate).toDateString() === new Date().toDateString()).reduce((s, x) => s + x.totalSaleAmount, 0)
  useEffect(() => { if (isManager) loadOrders() }, [loadOrders, isManager])

  function requestSupervisorApproval(actionLabel: string, reasonPrompt: string, defaultReason: string): ApprovalPayload | null {
    const supervisorPin = window.prompt(`Supervisor PIN required to ${actionLabel}`, '')
    if (supervisorPin == null) return null

    const normalizedPin = supervisorPin.trim()
    if (!/^\d{5}$/.test(normalizedPin)) {
      window.alert('Supervisor PIN must be exactly 5 digits.')
      return null
    }

    const reason = window.prompt(reasonPrompt, defaultReason)
    if (reason == null) return null

    return {
      supervisorPin: normalizedPin,
      reason: reason.trim() || defaultReason,
    }
  }

  function addDishToOrder(dish: Dish) {
    setAddingNew(false) // once a dish is tapped, we're genuinely building
    setLocalCart(prev => {
      const cart = prev[selectedTableKey] ?? []
      const existing = cart.find(i => i.dishId === dish.id)
      const updated  = existing
        ? cart.map(i => i.dishId === dish.id ? { ...i, qty: i.qty + 1 } : i)
        : [...cart, { dishId: dish.id, dishName: dish.name, dishPrice: dish.sellingPrice, qty: 1 }]
      return { ...prev, [selectedTableKey]: updated }
    })
    setAddedFlash(true); setTimeout(() => setAddedFlash(false), 1500)
  }

  function buildOfflineQueueEntryId(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  async function queueOrderCreatesOffline(params: {
    cart: Array<{ dishId: string; dishName: string; dishPrice: number; qty: number }>
    batchActionId: string
    tableId: string | null
    tableName: string
    waiterName: string
  }) {
    const localOrderId = `offline-order-${params.batchActionId}`
    const totalAmount = calculateGrossFromNet(params.cart.reduce((sum, item) => sum + item.dishPrice * item.qty, 0))
    const createdAt = new Date().toISOString()

    const entries = params.cart.map((item, index) => {
      const localItemId = `offline-item-${params.batchActionId}-${index + 1}`
      return {
        id: buildOfflineQueueEntryId('queue-create'),
        kind: 'pending.create' as const,
        label: `Create ${item.dishName} for ${params.tableName}`,
        createdAt,
        attempts: 0,
        lastError: null,
        request: {
          url: '/api/restaurant/pending',
          method: 'POST' as const,
          body: {
            tableId: params.tableId ?? 'takeaway',
            tableName: params.tableName,
            waiterName: params.waiterName,
            dishId: item.dishId,
            dishName: item.dishName,
            dishPrice: item.dishPrice,
            qty: item.qty,
            actionKey: `${params.batchActionId}-${item.dishId}`,
          },
        },
        projection: {
          type: 'append-pending-item' as const,
          item: {
            id: localItemId,
            orderId: localOrderId,
            orderNumber: 'Queued offline',
            tableId: params.tableId,
            tableName: params.tableName,
            dishId: item.dishId,
            dishName: item.dishName,
            dishPrice: item.dishPrice,
            qty: item.qty,
            status: 'new',
            waiter: { id: session?.user?.id, name: params.waiterName },
            addedAt: createdAt,
            orderServedAt: null,
            paymentMethod: null,
            totalAmount,
            notes: null,
          },
        },
      }
    })

    enqueueRestaurantOfflineQueue(entries)
    setLocalCart((current) => ({ ...current, [selectedTableKey]: [] }))
    setAddingNew(false)
    setSelectedTableKey(params.tableId ?? 'takeaway')
    setShowPanel('order')
    setOfflineQueueMessage(`Queued ${entries.length} item${entries.length === 1 ? '' : 's'} offline. They will sync automatically when internet returns.`)
  }

  async function queueLifecycleActionOffline(entry: RestaurantOfflineQueueEntry, successMessage: string) {
    enqueueRestaurantOfflineQueue(entry)
    refreshOfflineQueue()
    setOfflineQueueMessage(successMessage)
  }

  function discardOfflineDraftOrder(orderId: string) {
    removeRestaurantOfflineQueueEntries((entry) => (
      entry.projection.type === 'append-pending-item' && entry.projection.item.orderId === orderId
    ))
    setOfflineQueueMessage('Queued offline order discarded before sync.')
  }

  function discardOfflineDraftItem(itemId: string) {
    removeRestaurantOfflineQueueEntries((entry) => (
      entry.projection.type === 'append-pending-item' && entry.projection.item.id === itemId
    ))
    setOfflineQueueMessage('Queued offline item removed before sync.')
  }

  function removeLocalCartItem(dishId: string) {
    setLocalCart(prev => {
      const updated = (prev[selectedTableKey] ?? []).filter(i => i.dishId !== dishId)
      return { ...prev, [selectedTableKey]: updated }
    })
  }

  async function confirmOrder() {
    const cart = localCart[selectedTableKey] ?? []
    if (!cart.length) return
    if (orderSubmitLockRef.current) return
    setSubmitError(null)
    const waiterName = selectedWaiterName.trim()
    if (!waiterName) {
      setSubmitError('Waiter name is required before confirming this order.')
      return
    }
    const tableName = selectedTableKey === 'takeaway'
      ? 'Takeaway'
      : (tables.find(t => t.id === selectedTableKey)?.name ?? 'Table')
    orderSubmitLockRef.current = true
    setConfirmingOrder(true)
    try {
      const batchActionId = createActionId(`pending-${selectedTableKey}`)
      const normalizedTableId = selectedTableKey === 'takeaway' ? null : selectedTableKey
      const responses = await Promise.all(cart.map(item =>
        fetch('/api/restaurant/pending', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          tableId:   normalizedTableId ?? 'takeaway',
          tableName,
          waiterName,
          dishId: item.dishId,
          dishName: item.dishName,
          dishPrice: item.dishPrice,
          qty: item.qty,
          actionKey: `${batchActionId}-${item.dishId}`,
        })
        })
      ))

      const failed = responses.find((response) => !response.ok)
      if (failed) {
        const payload = await failed.json().catch(() => null)
        throw new Error(payload?.error || 'Failed to confirm order')
      }

      setLocalCart(prev => ({ ...prev, [selectedTableKey]: [] }))
      setAddingNew(false)
      setSelectedTableKey('takeaway')
      setShowPanel('dishes')
      await loadPending(); await loadTables()
      window.dispatchEvent(new CustomEvent('refreshTables'))
    } catch (error: any) {
      if ((typeof navigator !== 'undefined' && navigator.onLine === false) || isLikelyOfflineError(error)) {
        await queueOrderCreatesOffline({
          cart,
          batchActionId: createActionId(`pending-${selectedTableKey}`),
          tableId: selectedTableKey === 'takeaway' ? null : selectedTableKey,
          tableName,
          waiterName,
        })
        return
      }

      setSubmitError(error?.message || 'Failed to confirm order')
    } finally {
      orderSubmitLockRef.current = false
      setConfirmingOrder(false)
    }
  }

  async function printBill(tableKey: string) {
    const items    = pending.filter(p => (p.tableId ?? 'takeaway') === tableKey)
    if (!items.length) return
    const tName    = tableKey === 'takeaway' ? 'Takeaway' : (tables.find(t => t.id === tableKey)?.name ?? 'Table')
    const sub      = items.reduce((s, i) => s + i.dishPrice * i.qty, 0)
    const vat      = Math.round(calculateVatFromNet(sub))
    const tot      = Math.round(calculateGrossFromNet(sub))
    const now      = new Date().toLocaleString('en-RW', { dateStyle: 'medium', timeStyle: 'short' })
    // Always fetch the latest saved template so edits in Settings take effect immediately
    let latestBillHeader = billHeader
    try {
      const setupRes = await fetch('/api/restaurant/setup', { credentials: 'include', cache: 'no-store' })
      if (setupRes.ok) {
        const setupData = await setupRes.json()
        latestBillHeader = setupData.restaurant?.billHeader ?? ''
        setBillHeader(latestBillHeader)
      }
    } catch { /* use cached value on network error */ }
    const template = parseRestaurantBillTemplate(latestBillHeader)
    const headerLines = template.topText
      ? template.topText.split('\n').map(l => `<p class="center">${l}</p>`).join('')
      : '<p class="center" style="font-size:15px;font-weight:bold">RECEIPT</p>'
    const footerLines = template.bottomText
      ? template.bottomText.split('\n').map(l => `<p class="center">${l}</p>`).join('')
      : '<p class="center">Thank you for dining with us!</p>'
    const rows     = items.map(i =>
      `<tr><td>${i.dishName}${i.qty > 1 ? ` x${i.qty}` : ''}</td><td style="text-align:right">${(i.dishPrice * i.qty).toLocaleString()} RWF</td></tr>`
    ).join('')
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>Bill – ${tName}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Courier New', monospace; font-size: 13px; width: 300px; margin: 0 auto; padding: 12px; }
  .center { text-align: center; }
  .divider { border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 3px 0; vertical-align: top; }
  td:last-child { text-align: right; white-space: nowrap; padding-left: 8px; }
  .total-row td { font-weight: bold; font-size: 14px; border-top: 1px dashed #000; padding-top: 6px; }
  .footer { text-align: center; margin-top: 10px; font-size: 11px; }
  @media print { @page { margin: 0; } }
</style></head><body>
${headerLines}
<div class="divider"></div>
<p class="center">${now}</p>
<p class="center">Table: ${tName}</p>
<div class="divider"></div>
<table>${rows}
  <tr><td>Price before VAT</td><td>${sub.toLocaleString()} RWF</td></tr>
  <tr><td>VAT (18%)</td><td>${vat.toLocaleString()} RWF</td></tr>
  <tr class="total-row"><td>TOTAL</td><td>${tot.toLocaleString()} RWF</td></tr>
</table>
<div class="divider"></div>
<div class="footer">${footerLines}</div>
</body></html>`
    const win = window.open('', '_blank', 'width=350,height=600')
    if (!win) return
    win.document.write(html)
    win.document.close()
    win.focus()
    win.print()
  }

  async function voidOrder(tableKey: string) {
    const tableItems = pending.filter(p => (p.tableId ?? 'takeaway') === tableKey)
    if (!tableItems.length) return
    if (tableItems.length > 0 && isOfflineDraftOrderId(tableItems[0]?.orderId)) {
      discardOfflineDraftOrder(tableItems[0].orderId)
      return
    }
    if (!tableItems.every((item) => item.status === 'new')) {
      window.alert('Once a dish is already in kitchen or ready, it must be marked as wasted instead of canceled.')
      return
    }

    const orderIds = [...new Set(tableItems.map(item => item.orderId))]
    const approval = requestSupervisorApproval('cancel this order', 'Cancellation reason', 'Canceled by staff')
    if (!approval) return
    const cancellationActionId = createActionId(`cancel-${tableKey}`)

    const responses = await Promise.all(orderIds.map(orderId =>
      fetch(`/api/restaurant/orders/${orderId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'cancel', cancelReason: approval.reason, supervisorPin: approval.supervisorPin, actionKey: `${cancellationActionId}-${orderId}` })
      })
    ))

    const failed = responses.find(res => !res.ok)
    if (failed) {
      const payload = await failed.json().catch(() => null)
      window.alert(payload?.error || 'Cancellation failed.')
      return
    }

    setLocalCart(prev => ({ ...prev, [tableKey]: [] }))

    setSelectedTableKey('takeaway')
    setShowPanel('dishes')
    await loadPending(); await loadTables()
    window.dispatchEvent(new CustomEvent('refreshTables'))
  }

  async function markOrderWasted(tableKey: string) {
    const tableItems = pending.filter(p => (p.tableId ?? 'takeaway') === tableKey)
    if (!tableItems.length) return
    if (tableItems.length > 0 && isOfflineDraftOrderId(tableItems[0]?.orderId)) {
      window.alert('This order is still queued offline. Let it sync first before marking kitchen items as wasted.')
      return
    }
    if (!tableItems.some((item) => item.status === 'in_kitchen' || item.status === 'ready')) {
      window.alert('Only dishes already in kitchen or ready can be marked as wasted.')
      return
    }

    const approval = requestSupervisorApproval('mark this dish as wasted', 'Why is this being wasted?', 'Wrong order prepared')
    if (!approval) return

    const orderIds = [...new Set(
      tableItems
        .filter((item) => item.status === 'in_kitchen' || item.status === 'ready')
        .map((item) => item.orderId)
    )]

    const responses = await Promise.all(orderIds.map(orderId =>
      fetch(`/api/restaurant/orders/${orderId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'waste', cancelReason: approval.reason, supervisorPin: approval.supervisorPin, actionKey: `${createActionId(`waste-${tableKey}`)}-${orderId}` })
      })
    ))

    const failed = responses.find(res => !res.ok)
    if (failed) {
      const payload = await failed.json().catch(() => null)
      window.alert(payload?.error || 'Failed to mark dishes as wasted.')
      return
    }

    await Promise.all([loadPending(), loadTables()])
    window.dispatchEvent(new CustomEvent('refreshTables'))
    window.dispatchEvent(new Event('refreshWastePending'))
  }

  async function removePendingItem(item: PendingItem) {
    if (isOfflineDraftOrderId(item.orderId)) {
      discardOfflineDraftItem(item.id)
      return
    }

    if (item.status !== 'new') {
      window.alert('Once a dish is already in kitchen or ready, it must be marked as wasted instead of removed.')
      return
    }

    const approval = requestSupervisorApproval('remove this item', 'Cancellation reason', 'Canceled by staff')
    if (!approval) return

    const actionKey = createActionId(`remove-${item.id}`)

    try {
      const res = await fetch('/api/restaurant/pending', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ orderId: item.id, cancelReason: approval.reason, supervisorPin: approval.supervisorPin, actionKey })
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        window.alert(payload?.error || 'Cancellation failed.')
        return
      }
      await Promise.all([loadPending(), loadTables()])
    } catch (error) {
      if ((typeof navigator !== 'undefined' && navigator.onLine === false) || isLikelyOfflineError(error)) {
        await queueLifecycleActionOffline({
          id: buildOfflineQueueEntryId('queue-remove'),
          kind: 'pending.delete',
          label: `Remove ${item.dishName}`,
          createdAt: new Date().toISOString(),
          attempts: 0,
          lastError: null,
          request: {
            url: '/api/restaurant/pending',
            method: 'DELETE',
            body: { orderId: item.id, cancelReason: approval.reason, supervisorPin: approval.supervisorPin, actionKey },
          },
          projection: {
            type: 'remove-pending-item',
            itemId: item.id,
          },
        }, 'Queued item removal offline. It will sync automatically when internet returns.')
        return
      }

      window.alert(error instanceof Error ? error.message : 'Cancellation failed.')
    }
  }

  async function markOrderServed(orderId: string) {
    if (isOfflineDraftOrderId(orderId)) {
      window.alert('This order is still queued offline. Let it sync first before marking it served.')
      return
    }

    const actionKey = createActionId(`serve-${orderId}`)

    try {
      await fetch(`/api/restaurant/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'serve', actionKey }),
      })
      await loadPending()
    } catch (error) {
      if ((typeof navigator !== 'undefined' && navigator.onLine === false) || isLikelyOfflineError(error)) {
        await queueLifecycleActionOffline({
          id: buildOfflineQueueEntryId('queue-serve'),
          kind: 'order.serve',
          label: `Mark order ${orderId} served`,
          createdAt: new Date().toISOString(),
          attempts: 0,
          lastError: null,
          request: {
            url: `/api/restaurant/orders/${orderId}`,
            method: 'PATCH',
            body: { action: 'serve', actionKey },
          },
          projection: {
            type: 'mark-order-served',
            orderId,
            servedAt: new Date().toISOString(),
          },
        }, 'Queued serve action offline. It will sync automatically when internet returns.')
      }
    }
  }

  async function collectPayment(key: string) {
    const items = pending.filter(p => (p.tableId ?? 'takeaway') === key)
    if (!items.length) return
    const orderId = items[0].orderId
    if (isOfflineDraftOrderId(orderId)) {
      window.alert('This order is still queued offline. Let it sync first before collecting payment.')
      return
    }
    if (paymentLockRef.current) return
    paymentLockRef.current = true
    setPayingSaving(true)
    const actionKey = createActionId(`pay-${orderId}`)
    try {
      const res = await fetch(`/api/restaurant/orders/${orderId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'pay', paymentMethod: payMethod, actionKey })
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        throw new Error(payload?.error || 'Payment failed.')
      }
      await Promise.all([loadPending(), loadSales(), loadTables()])
      window.dispatchEvent(new CustomEvent('refreshTables'))
      window.dispatchEvent(new CustomEvent('refreshTransactions', {
        detail: { count: 2, source: 'restaurant_order_payment' }
      }))
      setPayingTableKey(null); setPayMethod('Cash')
    } catch (error) {
      if ((typeof navigator !== 'undefined' && navigator.onLine === false) || isLikelyOfflineError(error)) {
        await queueLifecycleActionOffline({
          id: buildOfflineQueueEntryId('queue-pay'),
          kind: 'order.pay',
          label: `Collect payment for order ${orderId}`,
          createdAt: new Date().toISOString(),
          attempts: 0,
          lastError: null,
          request: {
            url: `/api/restaurant/orders/${orderId}`,
            method: 'PATCH',
            body: { action: 'pay', paymentMethod: payMethod, actionKey },
          },
          projection: {
            type: 'remove-order',
            orderId,
          },
        }, 'Queued payment offline. The order will sync and post its accounting entries when internet returns.')
        setPayingTableKey(null)
        setPayMethod('Cash')
      } else {
        window.alert(error instanceof Error ? error.message : 'Payment failed.')
      }
    } finally {
      paymentLockRef.current = false
      setPayingSaving(false)
    }
  }

  const categories     = Array.from(new Set(dishes.map(d => d.category).filter(Boolean))) as string[]
  const filteredDishes = dishes.filter(d => {
    if (selectedCategory && d.category !== selectedCategory) return false
    if (searchQuery) return d.name.toLowerCase().includes(searchQuery.toLowerCase())
    return true
  })
  const cartItems      = localCart[selectedTableKey] ?? []
  const confirmedItems = projectedPending.filter(p => (p.tableId ?? 'takeaway') === selectedTableKey)
  const currentOrderId = confirmedItems[0]?.orderId ?? null
  const currentOrderNumber = confirmedItems[0]?.orderNumber ?? null
  const currentOrderServed = Boolean(confirmedItems[0]?.orderServedAt)
  const currentOrderReady = confirmedItems.length > 0 && confirmedItems.every(item => item.status === 'ready')
  const currentOrderHasStarted = confirmedItems.some((item) => item.status === 'in_kitchen' || item.status === 'ready')
  const currentOrderCanBeCanceled = confirmedItems.length > 0 && confirmedItems.every((item) => item.status === 'new')
  const currentOrderQueuedOffline = isOfflineDraftOrderId(currentOrderId)
  const storedWaiterName = (waiterByTableKey[selectedTableKey] ?? '').trim()
  const selectedConfirmedWaiterName = (confirmedItems[0]?.waiter?.name ?? '').trim()
  const selectedWaiterName = selectedConfirmedWaiterName || storedWaiterName
  const waiterFieldLocked = Boolean(selectedConfirmedWaiterName)
  // While building OR user hit "New order": show cart (empty or filling). Otherwise show pending.
  const isBuilding     = cartItems.length > 0 || addingNew
  // Reset addingNew whenever the user switches table
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setAddingNew(false) }, [selectedTableKey])
  useEffect(() => {
    if (selectedConfirmedWaiterName) {
      if (storedWaiterName !== selectedConfirmedWaiterName) {
        setWaiterByTableKey((prev) => ({ ...prev, [selectedTableKey]: selectedConfirmedWaiterName }))
      }
    }
  }, [selectedConfirmedWaiterName, selectedTableKey, storedWaiterName])
  const rightItems     = isBuilding ? cartItems : confirmedItems
  const subtotal       = rightItems.reduce((s, i) => s + i.dishPrice * i.qty, 0)
  const vatAmt         = calculateVatFromNet(subtotal)
  const total          = calculateGrossFromNet(subtotal)
  const tableNumber    = selectedTableKey === 'takeaway'
    ? 'T/A'
    : `#${tables.findIndex(t => t.id === selectedTableKey) + 1}`
  const tableLabel     = selectedTableKey === 'takeaway'
    ? 'Takeaway'
    : (tables.find(t => t.id === selectedTableKey)?.name ?? 'Table')

  function OfflineQueueBanner() {
    if (offlineQueueEntries.length === 0 && !offlineQueueMessage && !showingCachedSnapshot) return null

    const toneClass = offlineQueueEntries.length > 0
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : showingCachedSnapshot
        ? 'border-sky-200 bg-sky-50 text-sky-900'
        : 'border-green-200 bg-green-50 text-green-800'

    return (
      <div className={`rounded-xl border px-4 py-3 text-sm ${toneClass}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold">
              {offlineQueueEntries.length > 0
                ? `${offlineQueueEntries.length} action${offlineQueueEntries.length === 1 ? '' : 's'} queued on this device`
                : showingCachedSnapshot
                  ? 'Showing last synced data from this device'
                  : 'Offline queue is clear'}
            </p>
            {showingCachedSnapshot && snapshotUpdatedLabel ? (
              <p className="mt-1 text-xs opacity-90">Last synced snapshot: {snapshotUpdatedLabel}</p>
            ) : null}
            {offlineQueueMessage ? <p className="mt-1 text-xs opacity-90">{offlineQueueMessage}</p> : null}
          </div>
          {offlineQueueEntries.length > 0 ? (
            <button
              type="button"
              onClick={() => { void flushOfflineQueue() }}
              disabled={offlineQueueSyncing}
              className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${offlineQueueSyncing ? 'animate-spin' : ''}`} />
              {offlineQueueSyncing ? 'Syncing…' : 'Sync queued actions'}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  // ── Shared payment modal ──────────────────────────────────────────────────────
  function PayModal({ tableKey, onClose }: { tableKey: string; onClose: () => void }) {
    const items = pending.filter(p => (p.tableId ?? 'takeaway') === tableKey)
    const sub   = items.reduce((s, i) => s + i.dishPrice * i.qty, 0)
    const vat   = calculateVatFromNet(sub)
    const tot   = calculateGrossFromNet(sub)
    const name  = tableKey === 'takeaway' ? 'Takeaway' : (tables.find(t => t.id === tableKey)?.name ?? 'Table')
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-gray-900">Collect Payment — {name}</h3>
            <button onClick={onClose}><X className="h-5 w-5 text-gray-400 hover:text-gray-600" /></button>
          </div>
          <div className="bg-gray-50 rounded-xl p-3 space-y-2">
            {items.map(item => (
              <div key={item.id} className="flex justify-between text-sm">
                <span className="text-gray-700">{item.dishName}{item.qty > 1 ? ` ×${item.qty}` : ''}</span>
                <span className="font-medium text-gray-900">{fmtRWF(item.dishPrice * item.qty)} RWF</span>
              </div>
            ))}
            <div className="border-t border-gray-200 pt-2 space-y-1">
              <div className="flex justify-between text-sm text-gray-500"><span>Subtotal</span><span>{fmtRWF(sub)} RWF</span></div>
              <div className="flex justify-between text-sm text-orange-600 font-medium"><span>VAT 18%</span><span>+{fmtRWF(vat)} RWF</span></div>
              <div className="flex justify-between font-bold text-base pt-1 border-t border-gray-200">
                <span>Total</span><span className="text-green-700">{fmtRWF(tot)} RWF</span>
              </div>
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-2 block">Payment Method</label>
            <div className="grid grid-cols-2 gap-2">
              {PAY_METHODS.map(m => (
                <button key={m} type="button" onClick={() => setPayMethod(m)}
                  className={`py-2.5 rounded-lg text-sm font-medium border transition-all ${payMethod === m ? 'bg-green-500 text-white border-green-500' : 'bg-white text-gray-700 border-gray-300 hover:border-green-400'}`}>
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2.5 rounded-xl hover:bg-gray-50">Cancel</button>
            <button onClick={() => collectPayment(tableKey)} disabled={payingSaving}
              className="flex-1 bg-green-500 hover:bg-green-600 disabled:opacity-60 text-white text-sm font-semibold py-2.5 rounded-xl">
              {payingSaving ? 'Processing…' : `Confirm ${payMethod}`}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── BILLS MODE ────────────────────────────────────────────────────────────────
  if (mode === 'bills') {
    return (
      <div className="space-y-4">
        <OfflineQueueBanner />
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-800">Active Orders</h2>
            <p className="text-sm text-gray-500">Today: <span className="font-semibold text-green-700">{fmtRWF(todayPaid)} RWF</span></p>
          </div>
          <button onClick={() => { loadPending(); loadTables() }} className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50">
            <RefreshCw className="h-4 w-4 text-gray-500" />
          </button>
        </div>
        {activeKeys.length === 0 ? (
          <div className="bg-white rounded-xl border-2 border-dashed border-gray-200 p-12 text-center">
            <Receipt className="h-10 w-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-500">No pending bills</p>
            <p className="text-xs text-gray-400 mt-1">Go to Menu to start a new order</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeKeys.map(key => {
              const items = byTable[key]
              const orderId = items[0]?.orderId
              const orderNumber = items[0]?.orderNumber
              const orderServed = Boolean(items[0]?.orderServedAt)
              const allReady = items.every(item => item.status === 'ready')
              const sub   = items.reduce((s, i) => s + i.dishPrice * i.qty, 0)
              const tot   = calculateGrossFromNet(sub)
              return (
                <div key={key} className="bg-white rounded-2xl border-2 border-amber-200 shadow-sm overflow-hidden">
                  <div className="bg-amber-50 px-4 py-3 flex items-center justify-between border-b border-amber-200">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                      <span className="font-bold text-gray-900 text-sm">{items[0].tableName}</span>
                      <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${orderServed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-600'}`}>
                        {orderServed ? 'Served' : 'Pending'}
                      </span>
                    </div>
                    <span className="text-xs text-gray-400">{orderNumber ?? `${items.length} item${items.length > 1 ? 's' : ''}`}</span>
                  </div>
                  <div className="px-4 py-3 space-y-2">
                    <div className="rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-600">
                      Waiter: <span className="font-semibold text-gray-900">{items[0].waiter?.name ?? 'Unassigned'}</span>
                    </div>
                    {items.map(item => (
                      <div key={item.id} className="flex items-center justify-between group">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {canRequestCancellation && (
                              <button onClick={() => removePendingItem(item)}
                              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-50 transition-opacity flex-shrink-0">
                              <X className="h-3 w-3 text-red-400" />
                            </button>
                          )}
                          <span className="text-xs text-gray-700 truncate">{item.dishName}</span>
                          {item.qty > 1 && <span className="text-xs text-gray-400 flex-shrink-0">×{item.qty}</span>}
                        </div>
                        <span className="text-xs font-semibold text-gray-900 flex-shrink-0 ml-2">{fmtRWF(item.dishPrice * item.qty)} RWF</span>
                      </div>
                    ))}
                  </div>
                  <div className="px-4 pb-4 pt-2 border-t border-gray-100 space-y-1">
                    <div className="flex justify-between text-xs text-gray-500"><span>Price before VAT</span><span>{fmtRWF(sub)} RWF</span></div>
                    <div className="flex justify-between text-xs text-orange-600"><span>VAT (18%)</span><span>+{fmtRWF(sub * VAT_RATE)} RWF</span></div>
                    <div className="flex justify-between text-sm font-bold text-gray-900 border-t border-gray-100 pt-1.5"><span>Total</span><span>{fmtRWF(tot)} RWF</span></div>
                    {orderId && allReady && !orderServed && canMarkServed && (
                      <button onClick={() => markOrderServed(orderId)}
                        className="w-full mt-2 bg-white border border-green-300 hover:bg-green-50 text-green-700 text-sm font-semibold py-2.5 rounded-xl flex items-center justify-center gap-2">
                        <CheckCircle2 className="h-4 w-4" /> Mark Served
                      </button>
                    )}
                    <button onClick={() => { setSelectedTableKey(key); setPayingTableKey(key) }}
                      className="w-full mt-2 bg-green-500 hover:bg-green-600 text-white text-sm font-semibold py-2.5 rounded-xl flex items-center justify-center gap-2">
                      <CreditCard className="h-4 w-4" /> Collect Payment
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {payingTableKey && <PayModal tableKey={payingTableKey} onClose={() => { setPayingTableKey(null); setPayMethod('Cash') }} />}
      </div>
    )
  }

  // ── HISTORY MODE ──────────────────────────────────────────────────────────────
  if (mode === 'history') {
    return (
      <div className="space-y-4">
        <OfflineQueueBanner />
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-800">Transactions</h2>
            <p className="text-sm text-gray-500">Today: <span className="font-semibold text-green-700">{fmtRWF(todayPaid)} RWF</span></p>
          </div>
          <button onClick={loadSales} className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50">
            <RefreshCw className="h-4 w-4 text-gray-500" />
          </button>
        </div>
        {loading ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : sales.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
            <ShoppingBag className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">No completed sales yet</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>{['Date', 'Dish', 'Waiter', 'Qty', 'Revenue', 'Food Cost', 'Margin', 'Payment'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {sales.map(s => {
                  const mgn = s.totalSaleAmount > 0 ? ((s.totalSaleAmount - s.calculatedFoodCost) / s.totalSaleAmount * 100) : 0
                  return (
                    <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-gray-500 text-xs">{new Date(s.saleDate).toLocaleString('en-RW', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{s.dish.name}</p>
                        {(s.orderNumber || s.tableName) && (
                          <p className="mt-0.5 text-xs text-gray-400">{[s.orderNumber, s.tableName].filter(Boolean).join(' · ')}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{s.waiterName || '—'}</td>
                      <td className="px-4 py-3 text-gray-700">{s.quantitySold}</td>
                      <td className="px-4 py-3 font-semibold text-green-700">{fmtRWF(s.totalSaleAmount)} RWF</td>
                      <td className="px-4 py-3 text-orange-600">{fmtRWF(s.calculatedFoodCost)} RWF</td>
                      <td className="px-4 py-3"><span className={`text-xs font-bold ${mgn >= 60 ? 'text-green-600' : mgn >= 40 ? 'text-amber-600' : 'text-red-600'}`}>{mgn.toFixed(0)}%</span></td>
                      <td className="px-4 py-3"><span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{s.paymentMethod}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  if (mode === 'pos' && isManager) {
    return (
      <div className="space-y-5">
        <OfflineQueueBanner />
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="flex items-center gap-2">
                <ClipboardList className="h-5 w-5 text-orange-500" />
                <h2 className="font-semibold text-gray-800">Orders History</h2>
              </div>
              <p className="mt-1 text-sm text-gray-500">See each order from creation to completion or cancellation.</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {(['all', 'today', 'week', 'month'] as const).map((period) => (
                <button
                  key={period}
                  onClick={() => setMgmtPeriod(period)}
                  className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${mgmtPeriod === period ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                >
                  {period === 'all' ? 'All time' : period === 'today' ? 'Today' : period === 'week' ? '7 Days' : 'Month'}
                </button>
              ))}
              {(['ALL', 'PENDING', 'SERVED', 'PAID', 'CANCELED'] as const).map((status) => (
                <button
                  key={status}
                  onClick={() => setMgmtStatus(status)}
                  className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${mgmtStatus === status ? 'bg-orange-500 text-white' : 'bg-orange-50 text-orange-700 hover:bg-orange-100'}`}
                >
                  {status}
                </button>
              ))}
              <button onClick={loadOrders} className="p-2 rounded-lg hover:bg-gray-100" title="Refresh orders history">
                <RefreshCw className="h-4 w-4 text-gray-500" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 p-4 border-b border-gray-100 bg-gray-50/60">
            {[
              { label: 'Total', value: orderSummary?.total ?? 0, icon: ClipboardList, tone: 'text-gray-700', bg: 'bg-white' },
              { label: 'Pending', value: orderSummary?.pending ?? 0, icon: Clock, tone: 'text-amber-600', bg: 'bg-amber-50' },
              { label: 'Served', value: orderSummary?.served ?? 0, icon: ChefHat, tone: 'text-green-600', bg: 'bg-green-50' },
              { label: 'Paid', value: orderSummary?.paid ?? 0, icon: CheckCircle2, tone: 'text-emerald-600', bg: 'bg-emerald-50' },
              { label: 'Canceled', value: orderSummary?.canceled ?? 0, icon: Ban, tone: 'text-red-600', bg: 'bg-red-50' },
            ].map(({ label, value, icon: Icon, tone, bg }) => (
              <div key={label} className={`${bg} rounded-xl border border-gray-200 p-3`}>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-gray-500">{label}</p>
                  <Icon className={`h-4 w-4 ${tone}`} />
                </div>
                <p className={`mt-2 text-2xl font-bold ${tone}`}>{value}</p>
              </div>
            ))}
          </div>

          {recentOrders.length === 0 ? (
            <div className="p-10 text-center text-gray-400 text-sm">No orders found for this filter.</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {recentOrders.map((order) => (
                <div key={order.id} className="px-5 py-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-gray-900">{order.orderNumber}</p>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${order.displayStatus === 'PAID' ? 'bg-emerald-100 text-emerald-700' : order.displayStatus === 'CANCELED' ? 'bg-red-100 text-red-700' : order.displayStatus === 'SERVED' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                          {order.displayStatus}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">{order.tableName} · {order.createdByName} · {new Date(order.createdAt).toLocaleString('en-RW', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-gray-900">{fmtRWF(order.totalAmount)} RWF</p>
                      {order.paymentMethod && <p className="text-xs text-gray-400 mt-1">{order.paymentMethod}</p>}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {order.items.map((item) => (
                      <span key={item.id} className="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded-full">
                        {item.dishName}{item.qty > 1 ? ` ×${item.qty}` : ''}
                      </span>
                    ))}
                  </div>

                  <div className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">Order timeline</p>
                    <div className="flex flex-wrap gap-2">
                      {order.timeline.map((step, index) => (
                        <span key={`${order.id}-${index}`} className="text-xs bg-white border border-gray-200 text-gray-700 px-2 py-1 rounded-full">
                          {step}
                        </span>
                      ))}
                    </div>
                  </div>

                  {order.displayStatus === 'CANCELED' && order.cancelReason && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">Cancellation recorded</span>
                        <button
                          type="button"
                          className="inline-flex items-center justify-center rounded-full text-red-500 hover:text-red-700"
                          title={`Reason: ${order.cancelReason}${order.cancellationApprovedByEmployeeName && order.cancellationApprovedByEmployeeName !== order.canceledByName ? `\nApproved by: ${order.cancellationApprovedByEmployeeName}` : ''}`}
                        >
                          <CircleHelp className="h-4 w-4" />
                        </button>
                      </div>
                      <p className="mt-2 text-sm text-red-800">Reason: {order.cancelReason}</p>
                      {order.cancellationApprovedByEmployeeName && order.cancellationApprovedByEmployeeName !== order.canceledByName && <p className="mt-1 text-gray-600">Approved by {order.cancellationApprovedByEmployeeName}</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── POS MODE (default) ────────────────────────────────────────────────────────
  const readyTableNames = [...new Set(pending.filter(p => p.status === 'ready').map(p => p.tableName))]

  return (
    <div className="flex h-full overflow-hidden">

      {/* Ready-to-serve banner */}
      {readyTableNames.length > 0 && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-3 bg-green-500 text-white px-5 py-2.5 text-sm font-semibold shadow-md">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          <span>Ready to serve: {readyTableNames.join(', ')}</span>
        </div>
      )}

      {/* ── LEFT PANEL: categories + dishes ── */}
      <div className={`flex-1 flex flex-col min-w-0 overflow-hidden bg-gray-50 ${showPanel === 'order' ? 'hidden md:flex' : ''}`}>
        <div className="px-4 pt-4">
          <OfflineQueueBanner />
        </div>

        {/* Header */}
        <div className="bg-white border-b border-gray-200 px-5 flex flex-col flex-shrink-0">
          {/* Row 1: time label + icons — always stays in one line */}
          <div className="flex items-center justify-between py-3">
            <h2 className="text-xl font-bold text-gray-900">{getTimeLabel()}</h2>
            {activeKeys.length > 0 && (
              <span className="text-[13px] font-semibold text-orange-500">{activeKeys.length} pending</span>
            )}
            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Mobile: tap to open order panel */}
              {(cartItems.length > 0 || confirmedItems.length > 0) && (
                <button
                  onClick={() => setShowPanel('order')}
                  className="md:hidden flex items-center gap-1 bg-orange-500 text-white px-2.5 py-1 rounded-full text-xs font-bold flex-shrink-0"
                >
                  <ShoppingBag className="h-3.5 w-3.5" />
                  <span>{cartItems.length > 0 ? cartItems.length : confirmedItems.length}</span>
                </button>
              )}
              {showSearch ? (
                <input
                  autoFocus type="text" value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onBlur={() => { if (!searchQuery) setShowSearch(false) }}
                  placeholder="Search dishes…"
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-orange-400 w-40"
                />
              ) : (
                <button onClick={() => setShowSearch(true)} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
                  <Search className="h-5 w-5 text-gray-600" />
                </button>
              )}
              <div className="relative">
                <button className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
                  <Receipt className="h-5 w-5 text-gray-600" />
                </button>
                {activeKeys.length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] bg-blue-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 pointer-events-none">
                    {activeKeys.length}
                  </span>
                )}
              </div>
            </div>
          </div>
          {/* Row 2: all tables — orange if has orders, dark/neutral if empty */}
          {tables.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 py-4">
              {tables.map(table => {
                const key        = table.id
                const tItems     = byTable[key] ?? []
                const hasOrders  = tItems.length > 0
                const allReady   = hasOrders && tItems.every(i => i.status === 'ready')
                const hasCooking = hasOrders && !allReady
                const tTotal     = calculateGrossFromNet(tItems.reduce((s, i) => s + i.dishPrice * i.qty, 0))
                const isSelected = key === selectedTableKey
                return (
                  <button key={key} onClick={() => { setSelectedTableKey(key); setShowPanel('order') }}
                    className={`relative flex-shrink-0 flex flex-col items-start px-5 py-3 rounded-2xl text-left transition-all border-2 min-w-[80px] ${
                      isSelected && allReady     ? 'bg-green-500 text-white border-green-500 shadow-md'
                      : isSelected && hasCooking ? 'bg-orange-500 text-white border-orange-500 shadow-md'
                      : isSelected               ? 'bg-gray-900 text-white border-gray-900 shadow-md'
                      : allReady                 ? 'bg-green-50 text-green-800 border-green-400 hover:border-green-500'
                      : hasCooking               ? 'bg-orange-50 text-orange-800 border-orange-300 hover:border-orange-400'
                                                 : 'bg-gray-900 text-white border-gray-900 hover:bg-gray-700'
                    }`}>
                    {/* Green tick when ready, red dot when still cooking */}
                    {allReady && (
                      <span className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-green-600 border-2 border-white flex items-center justify-center">
                        <CheckCircle2 className="h-3 w-3 text-white" />
                      </span>
                    )}
                    {hasCooking && (
                      <span className="absolute -top-1.5 -right-1.5 h-3.5 w-3.5 rounded-full bg-red-500 border-2 border-white" />
                    )}
                    <span className="text-[15px] font-bold leading-tight">{table.name}</span>
                    {allReady
                      ? <span className={`text-[11px] font-semibold mt-0.5 ${isSelected ? 'text-green-100' : 'text-green-600'}`}>Ready to serve</span>
                      : hasCooking
                        ? <span className={`text-[11px] font-semibold mt-0.5 ${isSelected ? 'text-orange-100' : 'text-orange-500'}`}>Cooking…</span>
                        : <span className="text-[11px] font-medium mt-0.5 text-gray-400">Empty &amp; free</span>
                    }
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Category tiles */}
        <div className="flex-shrink-0 px-4 pt-3 pb-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`rounded-xl px-4 py-3 text-left transition-all ${selectedCategory === null
              ? 'bg-gray-800 text-white shadow-md'
              : 'bg-white text-gray-700 border border-gray-200 hover:border-gray-300 hover:shadow-sm'}`}
          >
            <span className="block text-sm font-bold truncate">All items</span>
            <span className="text-xs opacity-70">{dishes.length} items</span>
          </button>
          {categories.map((cat, idx) => {
            const [bg, fg] = COLOR_POOL[idx % COLOR_POOL.length]
            const count = dishes.filter(d => d.category === cat).length
            const isActive = selectedCategory === cat
            return (
              <button key={cat}
                onClick={() => setSelectedCategory(isActive ? null : cat)}
                className={`rounded-xl px-4 py-3 text-left transition-all ${bg} ${fg} ${isActive ? 'ring-2 ring-gray-900 ring-offset-2' : 'hover:scale-[1.02] hover:shadow-md'}`}
              >
                <span className="block text-sm font-bold truncate">{cat}</span>
                <span className="text-xs opacity-90">{count} items</span>
              </button>
            )
          })}
        </div>

        {/* Dish grid */}
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {addedFlash && (
            <div className="mb-3 flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-xs font-semibold px-3 py-2 rounded-xl">
              <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" /> Added to order
            </div>
          )}
          {filteredDishes.length === 0 ? (
            <div className="py-12 text-center text-gray-500 text-sm">No dishes found</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {filteredDishes.map(dish => {
                const qtyInOrder = cartItems.filter(i => i.dishId === dish.id).reduce((s, i) => s + i.qty, 0)
                const catIdx     = categories.indexOf(dish.category ?? '')
                const [bgTop,,bgBottom] = catIdx >= 0 ? COLOR_POOL[catIdx % COLOR_POOL.length] : ['bg-slate-400', 'text-white', 'bg-slate-700']
                const initials   = dish.name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
                return (
                  <button
                    key={dish.id}
                    onClick={() => addDishToOrder(dish)}
                    className="relative rounded-2xl overflow-hidden hover:shadow-lg hover:scale-[1.03] active:scale-[0.97] transition-all text-left flex flex-col h-full"
                  >
                    <div className={`${bgTop} h-[90px] w-full flex items-center justify-center`}>
                      <span className="text-white font-black text-3xl tracking-tight select-none drop-shadow">{initials}</span>
                    </div>
                    <div className={`${bgBottom} px-2.5 py-2.5 flex-1 w-full`}>
                      <p className="text-white text-[13px] font-semibold leading-tight line-clamp-2">{dish.name}</p>
                      <p className="text-white/70 font-medium text-[11px] mt-1">{fmtRWF(calculateGrossFromNet(dish.sellingPrice))} RWF incl. VAT</p>
                    </div>
                    {qtyInOrder > 0 && (
                      <span className="absolute top-2 right-2 h-6 min-w-[24px] bg-gray-900 border-2 border-white text-white text-xs font-bold rounded-full flex items-center justify-center px-1.5 shadow-sm">
                        {qtyInOrder}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── RIGHT PANEL: current order / check ── */}
      <div className={`flex flex-col bg-white border-l border-gray-200 md:flex-shrink-0 md:w-80 ${
        showPanel === 'dishes' ? 'hidden md:flex' : 'flex w-full'
      }`}>

        {/* Order header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 flex-shrink-0">
          {/* Back button — visible on all screen sizes */}
          <button onClick={() => setShowPanel('dishes')} className="p-1.5 -ml-1.5 mr-1 rounded-lg hover:bg-gray-100 transition-colors flex-shrink-0">
            <ArrowLeft className="h-5 w-5 text-gray-600" />
          </button>
          <span className="text-2xl font-black text-gray-900">{tableNumber}</span>
          <select
            value={selectedTableKey}
            onChange={e => setSelectedTableKey(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-orange-400 bg-white text-gray-600"
          >
            <option value="takeaway">Takeaway</option>
            {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        {/* Tabs: Check / Actions / Guest */}
        <div className="flex border-b border-gray-200 flex-shrink-0">
          {(['check', 'actions', 'guest'] as const).map(tab => (
            <button key={tab} onClick={() => setOrderTab(tab)}
              className={`flex-1 py-3 text-sm font-medium capitalize transition-colors border-b-2 ${orderTab === tab ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        <div className="border-b border-gray-100 px-4 py-3 flex-shrink-0">
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500">Waiter Taking Order</label>
          <input
            type="text"
            value={selectedWaiterName}
            onChange={(e) => {
              const nextName = e.target.value
              setWaiterByTableKey((prev) => ({ ...prev, [selectedTableKey]: nextName }))
              if (submitError) setSubmitError(null)
            }}
            placeholder="Enter waiter name"
            disabled={waiterFieldLocked || confirmingOrder}
            className={`mt-2 w-full rounded-xl border px-3 py-2.5 text-sm text-gray-900 outline-none transition-colors ${selectedWaiterName.trim() ? 'border-gray-200 focus:border-orange-400 focus:ring-2 focus:ring-orange-100' : 'border-red-300 focus:border-red-400 focus:ring-2 focus:ring-red-100'} disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500`}
          />
          <p className="mt-1 text-[11px] text-gray-400">
            {waiterFieldLocked
              ? 'Saved from this table\'s active order.'
              : 'Enter the waiter name before confirming. This same name will be used when payment is recorded.'}
          </p>
        </div>

        {/* ── Check tab ── */}
        {orderTab === 'check' && (
          <>
            {/* Mode label */}
            <div className={`flex-shrink-0 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-widest ${
              isBuilding ? 'bg-orange-50 text-orange-600' : confirmedItems.length > 0 ? 'bg-amber-50 text-amber-700' : 'bg-gray-50 text-gray-400'
            }`}>
              {isBuilding ? 'Building order — not sent yet' : confirmedItems.length > 0 ? 'Pending Orders' : 'No items'}
            </div>

            {!isBuilding && confirmedItems.length > 0 && (
              <div className="px-4 pt-3 pb-1 flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Order</p>
                  <p className="text-sm font-bold text-gray-900">{currentOrderNumber}</p>
                </div>
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${currentOrderQueuedOffline ? 'bg-blue-100 text-blue-700' : currentOrderServed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                  {currentOrderQueuedOffline ? 'Queued offline' : currentOrderServed ? 'Served' : 'Pending'}
                </span>
              </div>
            )}

            {currentOrderQueuedOffline && (
              <div className="mx-4 mb-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                This order exists only on this device for now. It will become a real server order after the queued create actions sync.
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-4 py-3">
              {rightItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full py-12 text-gray-400">
                  <ShoppingBag className="h-8 w-8 mb-3 text-gray-300" />
                  <p className="text-sm">No items yet</p>
                  <p className="text-xs mt-1">Tap a dish to add it</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {isBuilding
                    ? cartItems.map(item => (
                        <div key={item.dishId} className="flex items-start justify-between group">
                          <div className="flex-1 min-w-0 flex items-center gap-1">
                            <button onClick={() => removeLocalCartItem(item.dishId)}
                              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-50 transition-opacity flex-shrink-0">
                              <Trash2 className="h-3.5 w-3.5 text-red-400" />
                            </button>
                            <span className="text-sm text-gray-800 font-medium leading-snug">
                              {item.dishName}{item.qty > 1 ? ` x ${item.qty}` : ''}
                            </span>
                          </div>
                          <span className="text-sm font-semibold text-gray-900 ml-3 flex-shrink-0">{fmtRWF(item.dishPrice * item.qty)} RWF</span>
                        </div>
                      ))
                    : confirmedItems.map(item => (
                        <div key={item.id} className="flex items-start justify-between group">
                          <div className="flex-1 min-w-0 flex items-center gap-1">
                            {canRequestCancellation && item.status === 'new' && (
                              <button onClick={() => removePendingItem(item)}
                                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-50 transition-opacity flex-shrink-0">
                                <Trash2 className="h-3.5 w-3.5 text-red-400" />
                              </button>
                            )}
                            <span className="text-sm text-gray-800 font-medium leading-snug">
                              {item.dishName}{item.qty > 1 ? ` x ${item.qty}` : ''}
                            </span>
                          </div>
                          <span className="text-sm font-semibold text-gray-900 ml-3 flex-shrink-0">{fmtRWF(item.dishPrice * item.qty)} RWF</span>
                        </div>
                      ))
                  }
                </div>
              )}
            </div>

            {rightItems.length > 0 && (
              <div className="flex-shrink-0 border-t border-gray-200 px-4 py-4 space-y-2">
                {submitError && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                    {submitError}
                  </div>
                )}
                <div className="flex justify-between text-sm text-gray-600"><span>Price before VAT</span><span>{fmtRWF(subtotal)} RWF</span></div>
                <div className="flex justify-between text-sm text-gray-600"><span>Tax (18%)</span><span>{fmtRWF(vatAmt)} RWF</span></div>
                <div className="flex justify-between text-base font-bold text-gray-900 border-t border-gray-100 pt-2">
                  <span>Total</span><span>{fmtRWF(total)} RWF</span>
                </div>
                {isBuilding ? (
                  <>
                    <button onClick={confirmOrder} disabled={confirmingOrder || !selectedWaiterName.trim()}
                      className="w-full bg-orange-500 hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60 text-white font-semibold py-4 rounded-2xl text-base transition-colors mt-1 shadow-sm">
                      {confirmingOrder ? 'Confirming…' : 'Confirm Order'}
                    </button>
                    <button onClick={() => { setLocalCart(prev => ({ ...prev, [selectedTableKey]: [] })); setAddingNew(false) }} disabled={confirmingOrder}
                      className="w-full text-xs text-gray-400 hover:text-red-500 py-1 transition-colors">
                      Clear cart
                    </button>
                  </>
                ) : (
                  <>
                    {currentOrderId && currentOrderReady && !currentOrderServed && canMarkServed && (
                      <button onClick={() => markOrderServed(currentOrderId)}
                        className="w-full flex items-center justify-center gap-2 bg-white border border-green-300 hover:bg-green-50 text-green-700 font-semibold py-3 rounded-2xl text-sm transition-colors mt-1 shadow-sm">
                        <CheckCircle2 className="h-4 w-4" /> Mark Served
                      </button>
                    )}
                    <button onClick={() => printBill(selectedTableKey)}
                      className="w-full flex items-center justify-center gap-2 bg-gray-900 hover:bg-gray-700 text-white font-semibold py-4 rounded-2xl text-base transition-colors mt-1 shadow-sm">
                      <Printer className="h-5 w-5" /> Print Bill
                    </button>
                    <button onClick={() => setPayingTableKey(selectedTableKey)} disabled={currentOrderQueuedOffline}
                      className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-2xl text-base transition-colors shadow-sm">
                      Confirm Payment
                    </button>
                    <button onClick={() => setAddingNew(true)}
                      className="w-full bg-orange-50 hover:bg-orange-100 text-orange-600 font-semibold py-3 rounded-2xl text-sm transition-colors border border-orange-200">
                      ＋ New order for this table
                    </button>
                    {canRequestCancellation && currentOrderCanBeCanceled && (
                      <button onClick={() => voidOrder(selectedTableKey)}
                        className="w-full text-xs text-red-400 hover:text-red-600 py-1 transition-colors">
                        Cancel order
                      </button>
                    )}
                    {canRequestCancellation && currentOrderHasStarted && (
                      <button onClick={() => markOrderWasted(selectedTableKey)}
                        className="w-full text-xs text-red-500 hover:text-red-700 py-1 transition-colors font-semibold">
                        Mark as wasted
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}

        {/* ── Actions tab ── */}
        {orderTab === 'actions' && (
          <div className="flex-1 px-4 py-4 space-y-2">
            {onAskJesse && (
              <button onClick={onAskJesse}
                className="w-full flex items-center gap-2 px-4 py-3 rounded-xl border border-orange-200 bg-orange-50 text-orange-600 hover:bg-orange-100 text-sm font-medium transition-colors">
                <Sparkles className="h-4 w-4" /> Ask Jesse AI
              </button>
            )}
            <button onClick={() => { loadPending(); loadTables() }}
              className="w-full flex items-center gap-2 px-4 py-3 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 text-sm font-medium transition-colors">
              <RefreshCw className="h-4 w-4" /> Refresh orders
            </button>
          </div>
        )}

        {/* ── Guest tab ── */}
        {orderTab === 'guest' && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-400">
              <p className="text-sm font-medium">Guest info</p>
              <p className="text-xs mt-1">Coming soon</p>
            </div>
          </div>
        )}
      </div>

      {/* Payment modal */}
      {payingTableKey && (
        <PayModal tableKey={payingTableKey} onClose={() => { setPayingTableKey(null); setPayMethod('Cash') }} />
      )}
    </div>
  )
}

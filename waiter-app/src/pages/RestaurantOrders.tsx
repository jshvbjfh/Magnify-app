import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Search, ShoppingBag, CheckCircle2, CreditCard, RefreshCw,
  ArrowLeft, Trash2, X, Receipt, ShieldAlert,
} from 'lucide-react'
import {
  getDishes, getTables, getOrders, getOrderItems, createOrder, updateOrder, getConfig,
  type Dish, type RestaurantTable, type Order, type OrderItem,
} from '../services/db'
import { logError, logInfo, logWarn, normalizeErrorForLog } from '../services/logger'
import { pushSync, cancelOrderOnServer, validateCancellationPinOffline } from '../services/sync'

// ─── Types ───────────────────────────────────────────────────────────────────

type CartItem = { dishId: string; dishName: string; dishPrice: number; qty: number }

// ─── Constants ───────────────────────────────────────────────────────────────

const PAY_METHODS = ['Cash', 'MoMo', 'Card', 'Bank Transfer'] as const

const COLOR_POOL = [
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

const VAT_RATE = 0.18

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtRWF(n: number) {
  return n.toLocaleString('en-RW', { maximumFractionDigits: 0 })
}

function calcTotals(items: Array<{ dishPrice: number; qty: number }>) {
  const subtotal    = items.reduce((s, i) => s + i.dishPrice * i.qty, 0)
  const vatAmount   = Math.round(subtotal * VAT_RATE)
  const totalAmount = Math.round(subtotal * (1 + VAT_RATE))
  return { subtotal, vatAmount, totalAmount }
}

function getTimeLabel() {
  const h = new Date().getHours()
  if (h < 11) return 'Breakfast'
  if (h < 15) return 'Lunch'
  if (h < 18) return 'Afternoon'
  return 'Dinner'
}

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  }

  const now = Date.now().toString(16)
  const random = Math.random().toString(16).slice(2, 14).padEnd(12, '0')
  return `${now.slice(-8)}-${random.slice(0, 4)}-4${random.slice(4, 7)}-a${random.slice(7, 10)}-${random.slice(10, 12)}${Date.now().toString(16).slice(-10)}`
}

function getDisplayStatus(order: Order) {
  if (order.status === 'PAID')     return 'PAID'
  if (order.status === 'CANCELED') return 'CANCELED'
  if (order.served_at)             return 'SERVED'
  return 'PENDING'
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  mode?: 'pos' | 'history'
  waiterName: string
  onPendingCountChange?: (count: number) => void
  syncVersion?: number
}

export default function RestaurantOrders({ mode = 'pos', waiterName, onPendingCountChange, syncVersion }: Props) {
  // ── Shared state ──
  const [dishes,        setDishes]        = useState<Dish[]>([])
  const [tables,        setTables]        = useState<RestaurantTable[]>([])
  const [pendingOrders, setPendingOrders] = useState<Order[]>([])
  const [orderItemsMap, setOrderItemsMap] = useState<Record<string, OrderItem[]>>({})
  const [allOrders,     setAllOrders]     = useState<Order[]>([])
  const [loading,       setLoading]       = useState(true)
  const [restaurantId,  setRestaurantId]  = useState<string | null>(null)
  const [branchId,      setBranchId]      = useState<string | null>(null)

  // ── POS-only state ──
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [selectedTableKey, setSelectedTableKey] = useState<string>('takeaway')
  const [localCart,        setLocalCart]        = useState<Record<string, CartItem[]>>({})
  const [showPanel,        setShowPanel]        = useState<'dishes' | 'order'>('dishes')
  const [addedFlash,       setAddedFlash]       = useState(false)
  const [searchQuery,      setSearchQuery]      = useState('')
  const [showSearch,       setShowSearch]       = useState(false)
  const [confirmingOrder,  setConfirmingOrder]  = useState(false)
  const [submitError,      setSubmitError]      = useState<string | null>(null)
  const [confirmSuccess,   setConfirmSuccess]   = useState<string | null>(null)
  const [takenBy,          setTakenBy]          = useState('')
  const [payingTableKey,    setPayingTableKey]    = useState<string | null>(null)
  const [payMethod,         setPayMethod]         = useState('Cash')
  const [payingSaving,      setPayingSaving]      = useState(false)
  const [cancelingTableKey, setCancelingTableKey] = useState<string | null>(null)
  const [servingSaving,     setServingSaving]     = useState(false)

  const orderSubmitLockRef = useRef(false)
  const paymentLockRef     = useRef(false)
  const servingLockRef     = useRef(false)

  // ── Data loaders ──

  const loadPOS = useCallback(async () => {
    try {
      const [d, t, orders, rId, bId] = await Promise.all([
        getDishes(),
        getTables(),
        getOrders({ status: 'PENDING' }),
        getConfig('restaurantId'),
        getConfig('branchId'),
      ])
      setDishes(d)
      setTables(t)
      setPendingOrders(orders)
      setRestaurantId(rId)
      setBranchId(bId)

      if (!rId) {
        void logWarn('order', 'POS loaded without restaurant configuration', {
          dishes: d.length,
          tables: t.length,
          branchId: bId,
        })
      }

      // Load items for every pending order
      const itemsMap: Record<string, OrderItem[]> = {}
      await Promise.all(orders.map(async (o) => {
        itemsMap[o.id] = await getOrderItems(o.id)
      }))
      setOrderItemsMap(itemsMap)
    } catch { /* DB not ready on first render — will retry */ }
    setLoading(false)
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      setAllOrders(await getOrders())
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    if (mode === 'pos') loadPOS()
    else loadHistory()
  }, [mode, loadPOS, loadHistory, syncVersion])

  // Notify parent of how many tables have active orders (drives shell badge)
  useEffect(() => {
    if (mode !== 'pos') return
    const activeKeys = new Set(pendingOrders.map(o => o.table_id ?? 'takeaway'))
    onPendingCountChange?.(activeKeys.size)
  }, [pendingOrders, mode, onPendingCountChange])

  // takenBy is intentionally left blank — the waiter types the customer/order name

  // ── Cart actions ──

  function addDishToOrder(dish: Dish) {
    setLocalCart(prev => {
      const cart     = prev[selectedTableKey] ?? []
      const existing = cart.find(i => i.dishId === dish.id)
      const updated  = existing
        ? cart.map(i => i.dishId === dish.id ? { ...i, qty: i.qty + 1 } : i)
        : [...cart, { dishId: dish.id, dishName: dish.name, dishPrice: dish.selling_price, qty: 1 }]
      return { ...prev, [selectedTableKey]: updated }
    })
    setAddedFlash(true)
    setTimeout(() => setAddedFlash(false), 1500)
  }

  function removeLocalCartItem(dishId: string) {
    setLocalCart(prev => {
      const updated = (prev[selectedTableKey] ?? []).filter(i => i.dishId !== dishId)
      return { ...prev, [selectedTableKey]: updated }
    })
  }

  // ── Order lifecycle ──

  async function confirmOrder() {
    const cart = localCart[selectedTableKey] ?? []

    // ── Guard 1: empty cart ──────────────────────────────────────────────────
    if (!cart.length) {
      setSubmitError('No items in cart. Tap a dish to add it first.')
      return
    }

    // ── Guard 2: submit lock (debounce double-tap) ───────────────────────────
    if (orderSubmitLockRef.current) {
      setSubmitError('Order is already being confirmed — please wait.')
      return
    }

    // ── Guard 3: waiter name ─────────────────────────────────────────────────
    const name = takenBy.trim()
    if (!name) {
      setSubmitError('Please enter the waiter name before confirming.')
      return
    }

    // ── Guard 4: restaurant config ───────────────────────────────────────────
    if (!restaurantId) {
      void logWarn('order', 'Confirm order blocked: restaurant not configured', {
        selectedTableKey,
        itemCount: cart.length,
        branchId,
      })
      setSubmitError('Restaurant not configured. Sign out and back in.')
      return
    }

    setSubmitError(null)
    setConfirmSuccess(null)
    orderSubmitLockRef.current = true
    setConfirmingOrder(true)
    try {
      const orderId  = createId()
      const now      = new Date().toISOString()
      const tableId  = selectedTableKey === 'takeaway' ? null : selectedTableKey
      const tableName = selectedTableKey === 'takeaway'
        ? 'Takeaway'
        : (tables.find(t => t.id === selectedTableKey)?.name ?? 'Table')
      const { subtotal, vatAmount, totalAmount } = calcTotals(cart)

      await logInfo('order', 'Confirm order requested', {
        selectedTableKey,
        tableName,
        itemCount: cart.length,
        takenBy: name,
        restaurantId,
        branchId,
        totalAmount,
      })

      const orderNumber = `WA-${orderId.replace(/-/g, '').slice(-8).toUpperCase()}`

      const order: Order = {
        id:                 orderId,
        restaurant_id:      restaurantId,
        branch_id:          branchId,
        table_id:           tableId,
        table_name:         tableName,
        order_number:       orderNumber,
        status:             'PENDING',
        payment_method:     null,
        subtotal_amount:    subtotal,
        vat_amount:         vatAmount,
        total_amount:       totalAmount,
        created_by_name:    name,
        served_at:          null,
        paid_at:            null,
        canceled_at:        null,
        cancel_reason:      null,
        synced:             0,
        created_at:         now,
        updated_at:         now,
      }

      const items: OrderItem[] = cart.map((item) => ({
        id:         createId(),
        order_id:   orderId,
        dish_id:    item.dishId,
        dish_name:  item.dishName,
        dish_price: item.dishPrice,
        qty:        item.qty,
        status:     'ACTIVE',
        created_at: now,
        updated_at: now,
      }))

      await createOrder(order, items)
      await logInfo('order', 'Order saved locally', {
        orderId,
        selectedTableKey,
        tableName,
        itemCount: items.length,
        totalAmount,
      })

      // ── Reload BEFORE clearing cart so the panel never flashes empty ──────
      await loadPOS()
      setLocalCart(prev => ({ ...prev, [selectedTableKey]: [] }))
      setShowPanel('order')
      setConfirmSuccess(`${orderNumber} confirmed for ${tableName}`)
      setTimeout(() => setConfirmSuccess(null), 4000)

      pushSync().catch(() => {})
    } catch (err) {
      void logError('order', 'Confirm order failed', {
        selectedTableKey,
        itemCount: cart.length,
        restaurantId,
        branchId,
        error: normalizeErrorForLog(err),
      })
      setSubmitError(err instanceof Error ? err.message : 'Failed to confirm order')
    } finally {
      orderSubmitLockRef.current = false
      setConfirmingOrder(false)
    }
  }

  async function markOrderServed(orderId: string) {
    if (servingLockRef.current) return
    servingLockRef.current = true
    setServingSaving(true)
    try {
      await updateOrder(orderId, { served_at: new Date().toISOString() })
      await loadPOS()
      pushSync().catch(() => {})
    } finally {
      servingLockRef.current = false
      setServingSaving(false)
    }
  }

  async function collectPayment(tableKey: string) {
    const order = pendingOrders.find(o => (o.table_id ?? 'takeaway') === tableKey)
    if (!order || paymentLockRef.current) return
    paymentLockRef.current = true
    setPayingSaving(true)
    try {
      await updateOrder(order.id, {
        status:         'PAID',
        payment_method: payMethod,
        paid_at:        new Date().toISOString(),
      })
      await logInfo('order', 'Payment collected — queuing push', {
        orderId: order.id,
        orderNumber: order.order_number,
        paymentMethod: payMethod,
      })
      await loadPOS()
      pushSync().then(n => {
        void logInfo('sync', 'Post-payment push completed', { syncedOrders: n })
      }).catch(err => {
        void logError('sync', 'Post-payment push failed', { error: (err as Error).message })
      })
      setPayingTableKey(null)
      setPayMethod('Cash')
    } catch {}
    finally {
      paymentLockRef.current = false
      setPayingSaving(false)
    }
  }

  // cancelOrder is now handled by CancelModal — this stub kept for reference only

  // ── Derived values ──

  const categories = Array.from(new Set(dishes.map(d => d.category).filter(Boolean))) as string[]

  const filteredDishes = dishes.filter(d => {
    if (selectedCategory && d.category !== selectedCategory) return false
    if (searchQuery) return d.name.toLowerCase().includes(searchQuery.toLowerCase())
    return true
  })

  const cartItems      = localCart[selectedTableKey] ?? []
  const currentOrder   = pendingOrders.find(o => (o.table_id ?? 'takeaway') === selectedTableKey) ?? null
  const confirmedItems = currentOrder ? (orderItemsMap[currentOrder.id] ?? []) : []
  const isBuilding     = cartItems.length > 0
  const rightItems     = isBuilding
    ? cartItems
    : confirmedItems.map(i => ({ dishId: i.dish_id, dishName: i.dish_name, dishPrice: i.dish_price, qty: i.qty }))
  const { subtotal, vatAmount, totalAmount } = calcTotals(rightItems)
  const currentOrderServed = Boolean(currentOrder?.served_at)
  const activeTableKeys    = new Set(pendingOrders.map(o => o.table_id ?? 'takeaway'))

  // ── Pay modal ──

  function PayModal({ tableKey, onClose }: { tableKey: string; onClose: () => void }) {
    const order   = pendingOrders.find(o => (o.table_id ?? 'takeaway') === tableKey)
    const items   = order ? (orderItemsMap[order.id] ?? []) : []
    const sub     = items.reduce((s, i) => s + i.dish_price * i.qty, 0)
    const vat     = Math.round(sub * VAT_RATE)
    const tot     = Math.round(sub * (1 + VAT_RATE))
    const name    = tableKey === 'takeaway' ? 'Takeaway' : (tables.find(t => t.id === tableKey)?.name ?? 'Table')
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
                <span className="text-gray-700">{item.dish_name}{item.qty > 1 ? ` ×${item.qty}` : ''}</span>
                <span className="font-medium text-gray-900">{fmtRWF(item.dish_price * item.qty)} RWF</span>
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
                  className={`py-2.5 rounded-lg text-sm font-medium border transition-all ${
                    payMethod === m
                      ? 'bg-green-500 text-white border-green-500'
                      : 'bg-white text-gray-700 border-gray-300 hover:border-green-400'
                  }`}>
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2.5 rounded-xl hover:bg-gray-50">
              Cancel
            </button>
            <button onClick={() => collectPayment(tableKey)} disabled={payingSaving}
              className="flex-1 bg-green-500 hover:bg-green-600 disabled:opacity-60 text-white text-sm font-semibold py-2.5 rounded-xl">
              {payingSaving ? 'Processing…' : `Confirm ${payMethod}`}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HISTORY MODE
  // ─────────────────────────────────────────────────────────────────────────────

  if (mode === 'history') {
    const todayKey  = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date())
    const todayPaid = allOrders
      .filter(o => o.status === 'PAID' && new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date(o.created_at)) === todayKey)
      .reduce((s, o) => s + o.total_amount, 0)

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-800">Transactions</h2>
            <p className="text-sm text-gray-500">
              Today: <span className="font-semibold text-green-700">{fmtRWF(todayPaid)} RWF</span>
            </p>
          </div>
          <button onClick={loadHistory} className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50">
            <RefreshCw className="h-4 w-4 text-gray-500" />
          </button>
        </div>

        {loading ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400 text-sm">
            Loading…
          </div>
        ) : allOrders.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
            <ShoppingBag className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">No orders yet</p>
          </div>
        ) : (
          <div className="space-y-3">
            {allOrders.map(order => {
              const ds = getDisplayStatus(order)
              return (
                <div key={order.id} className="bg-white rounded-xl border border-gray-200 p-4 space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-gray-900">{order.order_number ?? '—'}</p>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                          ds === 'PAID'     ? 'bg-emerald-100 text-emerald-700' :
                          ds === 'CANCELED' ? 'bg-red-100 text-red-700'         :
                          ds === 'SERVED'   ? 'bg-green-100 text-green-700'     :
                                             'bg-amber-100 text-amber-700'
                        }`}>
                          {ds}
                        </span>
                        {!order.synced && (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                            Pending sync
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        {order.table_name ?? 'Takeaway'} · {order.created_by_name ?? waiterName} ·{' '}
                        {new Date(order.created_at).toLocaleString('en-RW', {
                          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                        })}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-bold text-gray-900">{fmtRWF(order.total_amount)} RWF</p>
                      {order.payment_method && (
                        <p className="text-xs text-gray-400 mt-0.5">{order.payment_method}</p>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POS MODE
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── LEFT PANEL: categories + dish grid ── */}
      <div className={`flex-1 flex flex-col min-w-0 overflow-hidden bg-gray-50 ${
        showPanel === 'order' ? 'hidden md:flex' : ''
      }`}>

        {/* Header */}
        <div className="bg-white border-b border-gray-200 px-5 flex flex-col flex-shrink-0">

          {/* Row 1: selected table name (or time label for takeaway) + search */}
          <div className="flex items-center justify-between py-3">
            <h2 className="text-xl font-bold text-gray-900">
              {selectedTableKey === 'takeaway'
                ? getTimeLabel()
                : (tables.find(t => t.id === selectedTableKey)?.name ?? getTimeLabel())}
            </h2>
            {activeTableKeys.size > 0 && (
              <span className="text-[13px] font-semibold text-orange-500">
                {activeTableKeys.size} pending
              </span>
            )}
            <div className="flex items-center gap-2 flex-shrink-0">
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
              <button onClick={() => { loadPOS(); setShowPanel('dishes') }}
                className="p-2 rounded-lg hover:bg-gray-100 transition-colors" title="Refresh">
                <RefreshCw className="h-4 w-4 text-gray-500" />
              </button>
            </div>
          </div>

          {/* Row 2: table selector */}
          {tables.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 py-4">
              {tables.map(table => {
                const key      = table.id
                const order    = pendingOrders.find(o => o.table_id === key)
                const hasOrder = Boolean(order)
                const isServed = Boolean(order?.served_at)
                const isSelected = key === selectedTableKey
                return (
                  <button key={key}
                    onClick={() => setSelectedTableKey(key)}
                    className={`relative flex-shrink-0 flex flex-col items-start px-5 py-3 rounded-2xl text-left transition-all border-2 min-w-[80px] ${
                      isSelected && isServed  ? 'bg-green-500  text-white border-green-500  shadow-md' :
                      isSelected && hasOrder  ? 'bg-orange-500 text-white border-orange-500 shadow-md' :
                      isSelected              ? 'bg-gray-900   text-white border-gray-900   shadow-md' :
                      isServed                ? 'bg-green-50   text-green-800  border-green-400  hover:border-green-500'  :
                      hasOrder                ? 'bg-orange-50  text-orange-800 border-orange-300 hover:border-orange-400' :
                                                'bg-gray-900   text-white border-gray-900 hover:bg-gray-700'
                    }`}>
                    {isServed && (
                      <span className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-green-600 border-2 border-white flex items-center justify-center">
                        <CheckCircle2 className="h-3 w-3 text-white" />
                      </span>
                    )}
                    {hasOrder && !isServed && (
                      <span className="absolute -top-1.5 -right-1.5 h-3.5 w-3.5 rounded-full bg-red-500 border-2 border-white" />
                    )}
                    <span className="text-[15px] font-bold leading-tight">{table.name}</span>
                    {isServed
                      ? <span className={`text-[11px] font-semibold mt-0.5 ${isSelected ? 'text-green-100' : 'text-green-600'}`}>Served</span>
                      : hasOrder
                        ? <span className={`text-[11px] font-semibold mt-0.5 ${isSelected ? 'text-orange-100' : 'text-orange-500'}`}>Pending…</span>
                        : <span className="text-[11px] font-medium mt-0.5 text-gray-400">Free</span>
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
            className={`rounded-xl px-4 py-3 text-left transition-all ${
              selectedCategory === null
                ? 'bg-gray-800 text-white shadow-md'
                : 'bg-white text-gray-700 border border-gray-200 hover:border-gray-300 hover:shadow-sm'
            }`}>
            <span className="block text-sm font-bold truncate">All items</span>
            <span className="text-xs opacity-70">{dishes.length} items</span>
          </button>
          {categories.map((cat, idx) => {
            const [bg, fg] = COLOR_POOL[idx % COLOR_POOL.length]
            const count    = dishes.filter(d => d.category === cat).length
            const isActive = selectedCategory === cat
            return (
              <button key={cat} onClick={() => setSelectedCategory(isActive ? null : cat)}
                className={`rounded-xl px-4 py-3 text-left transition-all ${bg} ${fg} ${
                  isActive ? 'ring-2 ring-gray-900 ring-offset-2' : 'hover:scale-[1.02] hover:shadow-md'
                }`}>
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
          {loading ? (
            <div className="py-12 text-center text-gray-400 text-sm">Loading menu…</div>
          ) : filteredDishes.length === 0 ? (
            <div className="py-12 text-center text-gray-400 text-sm">No dishes found</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {filteredDishes.map(dish => {
                const qtyInCart = cartItems.filter(i => i.dishId === dish.id).reduce((s, i) => s + i.qty, 0)
                const catIdx    = categories.indexOf(dish.category ?? '')
                const [bgTop,, bgBottom] = catIdx >= 0
                  ? COLOR_POOL[catIdx % COLOR_POOL.length]
                  : ['bg-slate-400', 'text-white', 'bg-slate-700']
                const initials = dish.name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
                return (
                  <button key={dish.id} onClick={() => addDishToOrder(dish)}
                    className="relative rounded-2xl overflow-hidden hover:shadow-lg hover:scale-[1.03] active:scale-[0.97] transition-all text-left flex flex-col h-full">
                    <div className={`${bgTop} h-[90px] w-full flex items-center justify-center`}>
                      <span className="text-white font-black text-3xl tracking-tight select-none drop-shadow">{initials}</span>
                    </div>
                    <div className={`${bgBottom} px-2.5 py-2.5 flex-1 w-full`}>
                      <p className="text-white text-[13px] font-semibold leading-tight line-clamp-2">{dish.name}</p>
                      <p className="text-white/70 font-medium text-[11px] mt-1">
                        {fmtRWF(Math.round(dish.selling_price * (1 + VAT_RATE)))} RWF incl. VAT
                      </p>
                    </div>
                    {qtyInCart > 0 && (
                      <>
                        <button
                          onClick={e => { e.stopPropagation(); removeLocalCartItem(dish.id) }}
                          className="absolute top-2 left-2 h-6 w-6 bg-red-500 border-2 border-white text-white rounded-full flex items-center justify-center shadow-sm z-10">
                          <X className="h-3 w-3" />
                        </button>
                        <span className="absolute top-2 right-2 h-6 min-w-[24px] bg-gray-900 border-2 border-white text-white text-xs font-bold rounded-full flex items-center justify-center px-1.5 shadow-sm">
                          {qtyInCart}
                        </span>
                      </>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* ── Yellow "Check Receipt" button — mobile only, appears when table has items ── */}
        {(cartItems.length > 0 || confirmedItems.length > 0) && (
          <div className="md:hidden flex-shrink-0 px-4 py-3 border-t border-gray-200 bg-gray-50">
            <button
              onClick={() => setShowPanel('order')}
              className="w-full bg-yellow-400 hover:bg-yellow-500 active:bg-yellow-500 text-gray-900 font-bold py-4 rounded-2xl text-base transition-colors shadow-sm flex items-center justify-center gap-2">
              <Receipt className="h-5 w-5" />
              {cartItems.length > 0
                ? `Order · ${cartItems.length} item${cartItems.length > 1 ? 's' : ''}`
                : 'Check Receipt'}
            </button>
          </div>
        )}
      </div>

      {/* ── RIGHT PANEL: current order ── */}
      <div className={`flex flex-col bg-white border-l border-gray-200 md:flex-shrink-0 md:w-80 ${
        showPanel === 'dishes' ? 'hidden md:flex' : 'flex w-full'
      }`}>

        {/* Panel header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 flex-shrink-0">
          <button onClick={() => setShowPanel('dishes')}
            className="p-1.5 -ml-1.5 mr-1 rounded-lg hover:bg-gray-100 transition-colors flex-shrink-0">
            <ArrowLeft className="h-5 w-5 text-gray-600" />
          </button>
          <span className="text-lg font-bold text-gray-900 flex-1 text-center">
            {selectedTableKey === 'takeaway' ? 'Takeaway' : (tables.find(t => t.id === selectedTableKey)?.name ?? 'Table')}
          </span>
        </div>

        {/* Mode label strip */}
        <div className={`flex-shrink-0 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-widest ${
          isBuilding             ? 'bg-orange-50 text-orange-600' :
          confirmedItems.length  ? 'bg-amber-50  text-amber-700'  :
                                   'bg-gray-50   text-gray-400'
        }`}>
          {isBuilding
            ? 'Building order — not sent yet'
            : confirmedItems.length
              ? `Order · ${currentOrder?.order_number ?? ''}`
              : 'Tap a dish to add items'}
        </div>

        {/* Items list */}
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
                          {item.dishName}{item.qty > 1 ? ` ×${item.qty}` : ''}
                        </span>
                      </div>
                      <span className="text-sm font-semibold text-gray-900 ml-3 flex-shrink-0">
                        {fmtRWF(item.dishPrice * item.qty)} RWF
                      </span>
                    </div>
                  ))
                : confirmedItems.map(item => (
                    <div key={item.id} className="flex items-start justify-between">
                      <span className="text-sm text-gray-800 font-medium leading-snug flex-1 min-w-0">
                        {item.dish_name}{item.qty > 1 ? ` ×${item.qty}` : ''}
                      </span>
                      <span className="text-sm font-semibold text-gray-900 ml-3 flex-shrink-0">
                        {fmtRWF(item.dish_price * item.qty)} RWF
                      </span>
                    </div>
                  ))
              }
            </div>
          )}
        </div>

        {/* Totals + action buttons */}
        {rightItems.length > 0 && (
          <div className="flex-shrink-0 border-t border-gray-200 px-4 py-4 space-y-2">

            {/* ── Success banner ── */}
            {confirmSuccess && (
              <div className="rounded-xl border border-green-300 bg-green-50 px-3 py-2.5 text-sm font-semibold text-green-800 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-600" />
                {confirmSuccess}
              </div>
            )}

            {/* ── Error banner ── */}
            {submitError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                {submitError}
              </div>
            )}

            <div className="flex justify-between text-sm text-gray-600">
              <span>Price before VAT</span><span>{fmtRWF(subtotal)} RWF</span>
            </div>
            <div className="flex justify-between text-sm text-gray-600">
              <span>Tax (18%)</span><span>{fmtRWF(vatAmount)} RWF</span>
            </div>
            <div className="flex justify-between text-base font-bold text-gray-900 border-t border-gray-100 pt-2">
              <span>Total</span><span>{fmtRWF(totalAmount)} RWF</span>
            </div>

            {isBuilding ? (
              <>
                {/* ── Waiter name field ── */}
                <div className="pt-1">
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Taken by</label>
                  <input
                    type="text"
                    value={takenBy}
                    onChange={e => { setTakenBy(e.target.value); setSubmitError(null) }}
                    placeholder="Who's taking this order?"
                    disabled={confirmingOrder}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-60"
                  />
                </div>

                <button onClick={confirmOrder} disabled={confirmingOrder}
                  className="w-full bg-orange-500 hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60 text-white font-semibold py-4 rounded-2xl text-base transition-colors mt-1 shadow-sm">
                  {confirmingOrder ? 'Confirming…' : 'Confirm Order'}
                </button>
                <button
                  onClick={() => { setLocalCart(prev => ({ ...prev, [selectedTableKey]: [] })); setSubmitError(null) }}
                  disabled={confirmingOrder}
                  className="w-full text-xs text-gray-400 hover:text-red-500 py-1 transition-colors">
                  Clear cart
                </button>
              </>
            ) : (
              <>
                {currentOrder && !currentOrderServed && (
                  <button onClick={() => markOrderServed(currentOrder.id)} disabled={servingSaving}
                    className="w-full flex items-center justify-center gap-2 bg-white border border-green-300 hover:bg-green-50 text-green-700 font-semibold py-3 rounded-2xl text-sm transition-colors mt-1 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed">
                    <CheckCircle2 className="h-4 w-4" /> {servingSaving ? 'Marking…' : 'Mark Served'}
                  </button>
                )}
                <button onClick={() => setPayingTableKey(selectedTableKey)}
                  className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-2xl text-base transition-colors shadow-sm flex items-center justify-center gap-2">
                  <CreditCard className="h-4 w-4" /> Collect Payment
                </button>
                <button onClick={() => { loadPOS() }}
                  className="w-full flex items-center justify-center gap-2 text-xs text-gray-500 hover:text-gray-800 border border-gray-200 hover:bg-gray-50 py-2.5 rounded-xl transition-colors">
                  <Receipt className="h-3.5 w-3.5" /> Refresh order
                </button>
                {currentOrder && (
                  <button
                    onClick={() => setCancelingTableKey(selectedTableKey)}
                    className="w-full flex items-center justify-center gap-1.5 text-xs text-red-400 hover:text-red-600 py-1 transition-colors">
                    <ShieldAlert className="h-3.5 w-3.5" /> Cancel order
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {payingTableKey && (
        <PayModal
          tableKey={payingTableKey}
          onClose={() => { setPayingTableKey(null); setPayMethod('Cash') }}
        />
      )}

      {cancelingTableKey && (
        <CancelModal
          tableKey={cancelingTableKey}
          onClose={() => setCancelingTableKey(null)}
        />
      )}
    </div>
  )

  // ── Cancel Modal ── (defined inside component to access closure state)
  function CancelModal({ tableKey, onClose }: { tableKey: string; onClose: () => void }) {
    const [pin,    setPin]    = useState('')
    const [reason, setReason] = useState('')
    const [saving, setSaving] = useState(false)
    const [error,  setError]  = useState<string | null>(null)

    const tableName = tableKey === 'takeaway'
      ? 'Takeaway'
      : (tables.find(t => t.id === tableKey)?.name ?? 'Table')

    async function submit() {
      if (pin.length !== 5) { setError('PIN must be exactly 5 digits'); return }
      if (!reason.trim())   { setError('Please enter a reason');        return }

      const order = pendingOrders.find(o => (o.table_id ?? 'takeaway') === tableKey)
      if (!order) { setError('Order not found'); return }

      setSaving(true)
      setError(null)
      try {
        let result: { approvedBy: string }
        try {
          result = await cancelOrderOnServer({
            orderId:       order.id,
            supervisorPin: pin,
            cancelReason:  reason.trim(),
          })
        } catch (serverErr) {
          const isNetworkErr = (serverErr as Error).name === 'NetworkRequestError'
          if (!isNetworkErr) throw serverErr
          // Server unreachable — validate PIN against cached bcrypt hashes
          result = await validateCancellationPinOffline(pin)
        }
        // Mirror cancellation in local DB so POS is consistent offline
        await updateOrder(order.id, {
          status:        'CANCELED',
          canceled_at:   new Date().toISOString(),
          cancel_reason: reason.trim(),
        })
        setLocalCart(prev => ({ ...prev, [tableKey]: [] }))
        setSelectedTableKey('takeaway')
        setShowPanel('dishes')
        setConfirmSuccess(`Order canceled · approved by ${result.approvedBy}`)
        setTimeout(() => setConfirmSuccess(null), 5000)
        await loadPOS()
        pushSync().catch(() => {})
        onClose()
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setSaving(false)
      }
    }

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-gray-900 flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-red-500" />
              Cancel Order — {tableName}
            </h3>
            <button onClick={onClose} disabled={saving}>
              <X className="h-5 w-5 text-gray-400 hover:text-gray-600" />
            </button>
          </div>

          <p className="text-sm text-gray-500">
            A supervisor must enter their 5-digit PIN to approve this cancellation.
          </p>

          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">Supervisor PIN</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={5}
              value={pin}
              onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 5)); setError(null) }}
              placeholder="● ● ● ● ●"
              className="w-full border border-gray-300 rounded-xl px-3 py-3 text-center text-2xl tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-red-400"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">Reason</label>
            <input
              type="text"
              value={reason}
              onChange={e => { setReason(e.target.value); setError(null) }}
              placeholder="e.g. Customer changed mind"
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
            />
          </div>

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 font-medium">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              disabled={saving}
              className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-3 rounded-xl hover:bg-gray-50 disabled:opacity-50">
              Go Back
            </button>
            <button
              onClick={submit}
              disabled={saving || pin.length !== 5 || !reason.trim()}
              className="flex-1 bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold py-3 rounded-xl transition-colors">
              {saving ? 'Canceling…' : 'Confirm Cancel'}
            </button>
          </div>
        </div>
      </div>
    )
  }
}

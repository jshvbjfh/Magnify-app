import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ShoppingBag, CheckCircle2, CreditCard, RefreshCw,
  ArrowLeft, Trash2, X, ShieldAlert, WifiOff, AlertCircle, Cloud, Printer, StickyNote,
  Search, ChevronDown, Lock,
} from 'lucide-react'
import {
  getDishes, getTables, getOrders, getOrderItems, createOrder, updateOrder, getConfig,
  getMepOutDishIds, addOrderItems, getOrderById, ORDER_SOURCE, markTicketsPushed,
  setItemDiscount, mergeOrdersLocal, lineNetAmount,
  recordKitchenTicket, moveOrderItemToNewOrder,
  type Dish, type RestaurantTable, type Order, type OrderItem,
} from '../services/db'
import SupervisorPinDialog from './SupervisorPinDialog'
import { logError, logInfo, logWarn, normalizeErrorForLog } from '../services/logger'
import { pushSync, cancelOrderOnServer, validateCancellationPinOffline, validateOrderCode, type BranchInfo } from '../services/sync'
import { getActiveShift, currentBusinessDateISO } from '../services/shifts'
import { getPrinterMap, getBillPrinter, resolveStationPrinter, listPrinters, isVirtualPrinter, parseBillTemplate, getBillNetworkPrinter, getBillEscposMode, printBillRaw, printTicketRaw, type PrinterMap, type PrinterInfo, type NetworkPrinterConfig } from '../services/printing'
import { hotelCreditLines, hotelBuffetPriceHidden } from '../services/hotelBuffet'
import { useOnline } from '../hooks/useOnline'

// ─── Types ───────────────────────────────────────────────────────────────────

type CartItem = { dishId: string; dishName: string; dishPrice: number; qty: number; note?: string;
  // Station that owns this line, stamped on the order item when it was rung
  // up. Set for lines replayed from a saved order; absent while building a
  // fresh cart, where the dish lookup below is authoritative.
  branchId?: string | null }

// ─── Constants ───────────────────────────────────────────────────────────────

// 'Credit' settles the tab on account rather than at the till: the server books
// it to Accounts Receivable (1200) instead of cash, and it needs the customer's
// name so the debt can be chased and collected later.
// 'No Charge' is a settlement, not a tender: the guests eat, the bill closes,
// and nothing is collected — the boss's guests, a comped table, a service
// recovery. It carries a mandatory reason, and books zero revenue while the
// food still comes off stock, so it can never quietly pad the day's takings.
// Kept in step with NO_CHARGE_METHOD in lib/restaurantOrders.ts. The server
// still recognises the older 'No Charge' spelling that shipped before this, so
// a till that has not updated yet keeps having its comps treated as comps.
const NO_CHARGE = 'compl.'
const PAY_METHODS = ['Cash', 'MoMo', 'Card', 'Bank Transfer', 'Credit', NO_CHARGE] as const

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtRWF(n: number) {
  return n.toLocaleString('en-RW', { maximumFractionDigits: 0 })
}

// Two-decimal amount for the bill's price column (e.g. 13,500.00).
function fmt2(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Code128-B barcode as inline SVG. Self-contained — no font or library needed.
// Bars generated at 1 unit each, then scaled to 70mm wide via viewBox so the
// barcode fits the 80mm paper regardless of order-number length.
const CODE128_PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312',
  '132212','221213','221312','231212','112232','122132','122231','113222',
  '123122','123221','223211','221132','221231','213212','223112','312131',
  '311222','321122','321221','312212','322112','322211','212123','212321',
  '232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121',
  '313121','211331','231131','213113','213311','213131','311123','311321',
  '331121','312113','312311','332111','314111','221411','431111','111224',
  '111422','121124','121421','141122','141221','112214','112412','122114',
  '122411','142111','241111','134111','111242','121142','121241','114212',
  '124112','124211','411212','421112','421211','212141','214121','412121',
  '111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
]
function code128svg(text: string): string {
  const codes = [104]          // START B
  let sum = 104
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) - 32
    codes.push(c)
    sum += c * (i + 1)
  }
  codes.push(sum % 103)        // check digit
  codes.push(106)              // STOP
  let x = 0
  const bars: string[] = []
  for (const code of codes) {
    const pat = CODE128_PATTERNS[code] ?? '211312'
    for (let i = 0; i < pat.length; i++) {
      const w = parseInt(pat[i])
      if (i % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${w}" height="48"/>`)
      x += w
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x} 48" width="70mm" height="14mm" style="display:block;margin:3mm auto 0">${bars.join('')}</svg>`
}

// Serialise every silent print job. Multiple receipts — a bill plus its kitchen
// and bar tickets, or several orders confirmed/paid in quick succession — must
// never print at the same time: concurrent hidden print windows collide on a
// single thermal printer, which cuts one receipt short and skips to the next.
// Each job waits for the previous to finish, then a short gap so the cutter and
// paper feed settle before the next starts.
let electronPrintQueue: Promise<void> = Promise.resolve()
const PRINT_GAP_MS = 250

function calcTotals(items: Array<{ dishPrice: number; qty: number; discountPercent?: number | null }>) {
  // Discounts are part of the price, not decoration. Without this the bill
  // printed the full menu total under discounted lines and the guest was asked
  // for money the till was not going to collect.
  const subtotal    = items.reduce((s, i) => s + lineNetAmount({ dish_price: i.dishPrice, qty: i.qty, discount_percent: i.discountPercent }), 0)
  // No VAT: the total is simply the sum of the item prices.
  return { subtotal, vatAmount: 0, totalAmount: subtotal }
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
  if (order.status === 'PAID')        return 'PAID'
  if (order.status === 'CANCELED')    return 'CANCELED'
  if (order.status === 'UNCONFIRMED') return 'NEW'
  if (order.served_at)                return 'SERVED'
  return 'PENDING'
}

// ─── Modals ──────────────────────────────────────────────────────────────────
// Defined at module scope (NOT nested inside RestaurantOrders) so their function
// identity is stable across the parent's frequent re-renders (sync ticks). A
// component defined inside the parent is re-created every render, which makes
// React remount the modal and wipe its input state mid-typing — that was the bug
// where a half-typed PIN / reason / order code kept resetting itself.

function OrderCodeModal({ onClose, onConfirmed }: { onClose: () => void; onConfirmed: (waiterName: string) => void }) {
  const [code,   setCode]   = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  async function submit() {
    if (code.length !== 4) { setError('Code must be exactly 4 digits'); return }
    setSaving(true)
    setError(null)
    try {
      const { waiterName } = await validateOrderCode(code)
      onConfirmed(waiterName)
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
          <h3 className="font-bold text-gray-900">Enter Your Order Code</h3>
          <button onClick={onClose} disabled={saving}>
            <X className="h-5 w-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>
        <p className="text-sm text-gray-500">Enter your 4-digit code to confirm this order.</p>
        {/* readOnly + inputMode none: use the on-screen keypad, never the OS virtual keyboard */}
        <input
          type="password"
          inputMode="none"
          readOnly
          maxLength={4}
          value={code}
          placeholder="● ● ● ●"
          className="w-full border border-gray-300 rounded-xl px-3 py-3 text-center text-2xl tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-orange-400"
        />
        {/* On-screen number pad for touch terminals — compact so it never overflows */}
        <div className="grid grid-cols-3 gap-1.5 max-w-[220px] mx-auto">
          {['1','2','3','4','5','6','7','8','9'].map(d => (
            <button key={d} type="button" disabled={saving}
              onClick={() => { setCode(c => (c + d).slice(0, 4)); setError(null) }}
              className="py-2 rounded-lg border border-gray-300 text-lg font-semibold text-gray-800 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50">
              {d}
            </button>
          ))}
          <button type="button" disabled={saving}
            onClick={() => { setCode(''); setError(null) }}
            className="py-2 rounded-lg border border-gray-300 text-xs font-semibold text-gray-500 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50">
            Clear
          </button>
          <button type="button" disabled={saving}
            onClick={() => { setCode(c => (c + '0').slice(0, 4)); setError(null) }}
            className="py-2 rounded-lg border border-gray-300 text-lg font-semibold text-gray-800 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50">
            0
          </button>
          <button type="button" disabled={saving}
            onClick={() => setCode(c => c.slice(0, -1))}
            className="py-2 rounded-lg border border-gray-300 text-lg font-semibold text-gray-800 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50">
            ⌫
          </button>
        </div>
        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 font-medium">
            {error}
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} disabled={saving}
            className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-3 rounded-xl hover:bg-gray-50 disabled:opacity-50">
            Cancel
          </button>
          <button onClick={() => void submit()} disabled={saving || code.length !== 4}
            className="flex-1 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-sm font-semibold py-3 rounded-xl transition-colors">
            {saving ? 'Checking…' : 'Confirm Order'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CancelModal({ order, onClose, onCanceled }: {
  order: Order | undefined
  onClose: () => void
  onCanceled: (approvedBy: string, tableKey: string) => void
}) {
  const [pin,    setPin]    = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  const tableKey  = order ? (order.table_id ?? 'takeaway') : 'takeaway'
  const tableName = order?.table_name ?? 'Order'

  async function submit() {
    if (pin.length !== 5) { setError('PIN must be exactly 5 digits'); return }
    if (!reason.trim())   { setError('Please enter a reason');        return }
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
      onCanceled(result.approvedBy, tableKey)
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

// ─── Module-level stale-while-revalidate caches ──────────────────────────────
// Survive tab switches; cleared only on app restart.

type PosSnapshot = {
  dishes: Dish[]
  tables: RestaurantTable[]
  pendingOrders: Order[]
  orderItemsMap: Record<string, OrderItem[]>
  restaurantId: string | null
  branchId: string | null
  restaurantName: string | null
  branches: BranchInfo[]
}
let posCache: PosSnapshot | null = null
let historyCache: Order[] | null = null

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  mode?: 'pos' | 'history' | 'pending'
  waiterName: string
  // True when the code that unlocked this till belongs to a manager or a
  // supervisor-PIN holder. Every pending table is then fully actionable, not
  // just this person's own — see ownsOrder.
  isSupervisor?: boolean
  activeBranchId?: string | null
  onPendingCountChange?: (count: number) => void
  syncVersion?: number
  // Selected table is owned by the shell so the Tables tab can drive it.
  selectedTableKey?: string
  onSelectTableKey?: (key: string) => void
  // Edit-pending-order flow: the pending tab requests an edit via onEditOrder;
  // the shell switches to the POS tab and passes the order id down here.
  editingOrderId?: string | null
  onEditOrder?: (orderId: string) => void
  onEditDone?: () => void
}

export default function RestaurantOrders({ mode = 'pos', waiterName = '', isSupervisor = false, activeBranchId = null, onPendingCountChange, syncVersion, selectedTableKey: controlledTableKey, onSelectTableKey, editingOrderId = null, onEditOrder, onEditDone }: Props) {
  const { isOnline } = useOnline()
  // ── Shared state ──
  const [dishes,        setDishes]        = useState<Dish[]>([])
  const [tables,        setTables]        = useState<RestaurantTable[]>([])
  const [pendingOrders, setPendingOrders] = useState<Order[]>([])
  const [orderItemsMap, setOrderItemsMap] = useState<Record<string, OrderItem[]>>({})
  const [allOrders,     setAllOrders]     = useState<Order[]>([])
  const [loading,       setLoading]       = useState(mode === 'history' ? !historyCache : !posCache)
  const [isRefreshing,  setIsRefreshing]  = useState(false)
  const [restaurantId,  setRestaurantId]  = useState<string | null>(null)
  const [branchId,      setBranchId]      = useState<string | null>(null)
  const [restaurantName, setRestaurantName] = useState<string | null>(posCache?.restaurantName ?? null)
  const [branches,       setBranches]       = useState<BranchInfo[]>(posCache?.branches ?? [])

  // ── POS-only state ──
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [internalTableKey, setInternalTableKey] = useState<string>('takeaway')
  const selectedTableKey = controlledTableKey ?? internalTableKey
  const setSelectedTableKey = onSelectTableKey ?? setInternalTableKey
  const [tablePickerOpen,  setTablePickerOpen]  = useState(false)
  const [tablePickerQuery, setTablePickerQuery] = useState('')
  const tablePickerRef = useRef<HTMLDivElement>(null)
  const tablePickerInputRef = useRef<HTMLInputElement>(null)
  const [localCart,        setLocalCart]        = useState<Record<string, CartItem[]>>({})
  // Covers per table, kept as the raw typed string so an empty box stays empty
  // rather than snapping to 0. Optional — a blank box records no guest count at
  // all, which reports read as "unknown" and leave out of the average.
  const [guestsByTable,    setGuestsByTable]    = useState<Record<string, string>>({})
  const [showPanel,        setShowPanel]        = useState<'dishes' | 'order'>('dishes')
  // Edit-pending flow: the order being extended + its already-sent items
  // (shown locked in the cart panel; only NEW items get kitchen tickets).
  const [editingOrder,     setEditingOrder]     = useState<Order | null>(null)
  const [editingItems,     setEditingItems]     = useState<OrderItem[]>([])
  const [addedFlash,       setAddedFlash]       = useState(false)
  const [searchQuery,      setSearchQuery]      = useState('')
  const [pendingSearch,    setPendingSearch]    = useState('')
  const [noteEditId,       setNoteEditId]       = useState<string | null>(null)
  const [activeItemId,     setActiveItemId]     = useState<string | null>(null)
  const [confirmingOrder,  setConfirmingOrder]  = useState(false)
  const [submitError,      setSubmitError]      = useState<string | null>(null)
  const [confirmSuccess,   setConfirmSuccess]   = useState<string | null>(null)
  const [showCodeModal,    setShowCodeModal]    = useState(false)
  // When set, the order-code modal confirms this incoming (guest QR) order instead of submitting a new cart.
  const [incomingConfirmId, setIncomingConfirmId] = useState<string | null>(null)
  const [payingOrderId,     setPayingOrderId]     = useState<string | null>(null)
  const [payMethod,         setPayMethod]         = useState('Cash')
  // Why nothing was charged. Required before a No Charge settlement can be
  // confirmed — a comp with no reason is indistinguishable from a mistake.
  const [noChargeReason,    setNoChargeReason]    = useState('')
  // Credit sales only: who owes for the tab. Name is required, phone optional.
  const [arCustomerName,    setArCustomerName]    = useState('')
  const [arCustomerPhone,   setArCustomerPhone]   = useState('')
  const [payingSaving,      setPayingSaving]      = useState(false)
  const [cancelingOrderId,  setCancelingOrderId]  = useState<string | null>(null)
  // Discount being entered on one line. Held until a supervisor approves it —
  // the percentage is typed first, the PIN second, and nothing is written until
  // both are in.
  const [discountTarget,    setDiscountTarget]    = useState<{ orderId: string; item: OrderItem } | null>(null)
  const [discountPct,       setDiscountPct]       = useState('')
  const [discountAwaitingPin, setDiscountAwaitingPin] = useState(false)
  // Moving one line to another table. Same two-step shape as a discount: choose
  // the destination, then a supervisor PIN approves it — a line changing bills
  // moves money between tables, so it takes the same approval a cancellation does.
  const [moveTarget,        setMoveTarget]        = useState<{ orderId: string; item: OrderItem } | null>(null)
  const [moveTableId,       setMoveTableId]       = useState<string>('')
  const [moveAwaitingPin,   setMoveAwaitingPin]   = useState(false)
  // Joining orders: a selection mode over the pending list. Off by default so
  // the list behaves exactly as before until a waiter asks to combine bills.
  const [joinMode,          setJoinMode]          = useState(false)
  const [joinIds,           setJoinIds]           = useState<string[]>([])
  const [joinAwaitingPin,   setJoinAwaitingPin]   = useState(false)
  const [joinError,         setJoinError]         = useState<string | null>(null)

  // Device-local printer routing (branchId → deviceName) + bill printer.
  const [printerMap,        setPrinterMap]        = useState<PrinterMap>({})
  const [billPrinter,       setBillPrinter]       = useState<string>('')
  const [billNetworkPrinter, setBillNetworkPrinter] = useState<NetworkPrinterConfig | null>(null)
  const [billEscposMode,    setBillEscposModeOn]   = useState<boolean>(false)
  const [billColumns,       setBillColumns]       = useState<number>(42)
  const [printers,          setPrinters]          = useState<PrinterInfo[]>([])
  // Manager-editable receipt template (raw billHeader; parsed into top/bottom at print time).
  const [billHeaderTpl, setBillHeaderTpl] = useState<string>('')

  const orderSubmitLockRef = useRef(false)
  const paymentLockRef     = useRef(false)

  // MEP "Out" badges: dishes whose prepared portions hit 0 on this station.
  // Informational only — ordering is never blocked (kitchen can still cook to order).
  const [outDishIds, setOutDishIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (mode === 'history') return
    let cancelled = false
    void (async () => {
      try {
        const activeBranch = await getConfig('activeBranchId')
        const ids = await getMepOutDishIds(activeBranch)
        if (!cancelled) setOutDishIds(new Set(ids))
      } catch { /* DB not ready yet */ }
    })()
    return () => { cancelled = true }
  }, [mode, syncVersion, activeBranchId])

  // ── Data loaders ──

  const loadPOS = useCallback(async () => {
    // Show cached data immediately so the user never stares at a blank screen.
    if (posCache) {
      setDishes(posCache.dishes)
      setTables(posCache.tables)
      setPendingOrders(posCache.pendingOrders)
      setOrderItemsMap(posCache.orderItemsMap)
      setRestaurantId(posCache.restaurantId)
      setBranchId(posCache.branchId)
      setLoading(false)
    }
    setIsRefreshing(true)
    try {
      const [rId, activeBranch] = await Promise.all([
        getConfig('restaurantId'),
        getConfig('activeBranchId'),
      ])
      const [d, t, orders, bId, rName, branchesJson] = await Promise.all([
        getDishes(activeBranch),
        getTables(),
        getOrders({ statuses: ['PENDING', 'UNCONFIRMED'], restaurantId: rId }),
        getConfig('branchId'),
        getConfig('restaurantName'),
        getConfig('branches'),
      ])
      const parsedBranches: BranchInfo[] = (() => {
        try { return branchesJson ? (JSON.parse(branchesJson) as BranchInfo[]) : [] }
        catch { return [] }
      })()
      setDishes(d)
      setTables(t)
      setPendingOrders(orders)
      setRestaurantId(rId)
      setBranchId(bId)
      setRestaurantName(rName)
      setBranches(parsedBranches)

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
      posCache = { dishes: d, tables: t, pendingOrders: orders, orderItemsMap: itemsMap, restaurantId: rId, branchId: bId, restaurantName: rName, branches: parsedBranches }
    } catch { /* DB not ready on first render — will retry */ }
    setLoading(false)
    setIsRefreshing(false)
  }, [])

  const loadHistory = useCallback(async () => {
    if (historyCache) {
      setAllOrders(historyCache)
      setLoading(false)
    }
    setIsRefreshing(true)
    try {
      const rId = await getConfig('restaurantId')
      const orders = await getOrders({ restaurantId: rId })
      setAllOrders(orders)
      historyCache = orders
    } catch {}
    setLoading(false)
    setIsRefreshing(false)
  }, [])

  // Clear POS cache when branch changes so the new branch's menu loads fresh.
  const prevBranchRef = useRef(activeBranchId)
  useEffect(() => {
    if (prevBranchRef.current !== activeBranchId) {
      posCache = null
      prevBranchRef.current = activeBranchId
      setLoading(true)
    }
  }, [activeBranchId])

  // Close the table picker on an outside click or Escape.
  useEffect(() => {
    if (!tablePickerOpen) return
    function handlePointerDown(e: MouseEvent) {
      if (tablePickerRef.current && !tablePickerRef.current.contains(e.target as Node)) {
        setTablePickerOpen(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setTablePickerOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [tablePickerOpen])

  useEffect(() => {
    if (mode === 'history') loadHistory()
    else loadPOS()
  }, [mode, loadPOS, loadHistory, syncVersion])

  // Load device-local printer routing for kitchen/bar tickets and bills.
  useEffect(() => {
    if (mode === 'history') return
    void (async () => {
      const [map, bill, list, tpl, net, colsRaw, escpos] = await Promise.all([getPrinterMap(), getBillPrinter(), listPrinters(), getConfig('billHeader'), getBillNetworkPrinter(), getConfig('billColumns'), getBillEscposMode()])
      setPrinterMap(map)
      setBillPrinter(bill)
      setPrinters(list)
      setBillHeaderTpl(tpl ?? '')
      setBillNetworkPrinter(net)
      setBillEscposModeOn(escpos)
      const parsedCols = parseInt(colsRaw ?? '', 10)
      setBillColumns(Number.isFinite(parsedCols) && parsedCols >= 24 && parsedCols <= 64 ? parsedCols : 42)
    })()
  }, [mode, syncVersion])

  // Notify parent of how many tables have active orders (drives shell badge)
  useEffect(() => {
    if (mode !== 'pos') return
    const activeKeys = new Set(pendingOrders.map(o => o.table_id ?? 'takeaway'))
    onPendingCountChange?.(activeKeys.size)
  }, [pendingOrders, mode, onPendingCountChange])

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

  function setCartItemNote(dishId: string, note: string) {
    setLocalCart(prev => {
      const updated = (prev[selectedTableKey] ?? []).map(i => i.dishId === dishId ? { ...i, note } : i)
      return { ...prev, [selectedTableKey]: updated }
    })
  }

  // ── Print helpers ──

  function escHtml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function printHtml(html: string, delay = 0, deviceName = '') {
    const eP = (window as Window & { electronPrint?: { receipt: (h: string, deviceName?: string) => Promise<void> } }).electronPrint
    if (eP) {
      // No real printer to target — warn instead of dumping the user into
      // Windows' "Save as PDF" dialog (the default printer is virtual).
      if (!deviceName) {
        const def = printers.find(p => p.isDefault)
        if (!def || isVirtualPrinter(def.name)) {
          setSubmitError('No receipt printer set — choose one in the Printers tab.')
          return
        }
      }
      // Chain onto the shared queue so this job only starts once the previous
      // one has fully printed — never two hidden print windows at once. The
      // `delay` arg is now just spacing between staggered jobs (kitchen tickets),
      // applied before this job rather than as a fixed wall-clock offset.
      electronPrintQueue = electronPrintQueue
        .then(() => new Promise<void>(res => setTimeout(res, delay)))
        .then(() => eP.receipt(html, deviceName || undefined))
        .catch((err) => {
          console.error(err)
          setSubmitError('Print failed — check the printer is on, has paper, and is assigned in the Printers tab.')
        })
        .then(() => new Promise<void>(res => setTimeout(res, PRINT_GAP_MS)))
      return
    }
    // Fallback: DOM injection for non-Electron environments
    setTimeout(() => {
      const ID = 'pos-receipt-print', SID = 'pos-receipt-print-style'
      document.getElementById(ID)?.remove(); document.getElementById(SID)?.remove()
      const parsed = new DOMParser().parseFromString(html, 'text/html')
      const styleEl = document.createElement('style')
      styleEl.id = SID
      styleEl.textContent = Array.from(parsed.querySelectorAll('style')).map(s => s.textContent ?? '').join('\n')
        + `\n@media screen{#${ID}{position:fixed;left:-9999px;top:0;width:58mm;opacity:0}}`
        + `\n@media print{body>*:not(#${ID}){display:none!important}#${ID}{display:block!important;position:static!important}}`
      const div = document.createElement('div')
      div.id = ID; div.innerHTML = parsed.body.innerHTML
      document.head.appendChild(styleEl); document.body.appendChild(div)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.print()
        window.addEventListener('afterprint', () => {
          document.getElementById(ID)?.remove(); document.getElementById(SID)?.remove()
        }, { once: true })
      }))
    }, delay)
  }

  function printBill(order: Order, items: OrderItem[]) {
    // Bill printers are commonly installed with a "Generic / Text Only"-class
    // driver that discards ALL CSS — no text-align, no flex, no borders, no
    // bold, no SVG. Only the literal characters print, in the printer's own
    // built-in font. So the bill is laid out as monospace TEXT: centred with
    // spaces, columns padded with spaces, dividers drawn with dashes. Because
    // the HTML font is also monospace, the same layout renders identically on
    // graphics drivers. Column count is device-configurable in the Printers
    // tab (58mm paper ≈ 32 cols, 80mm ≈ 42–48 cols).
    const LINE = billColumns
    const center = (s: string) =>
      s.length >= LINE ? s : ' '.repeat(Math.floor((LINE - s.length) / 2)) + s
    // Left + right on one line when they fit; otherwise keep the left text at
    // full length (wrapped at LINE) and right-align the value on the last
    // line — long dish names are never truncated.
    const cols = (left: string, right: string): string[] => {
      if (!right) return [left]
      if (left.length + 1 + right.length <= LINE) {
        return [left + ' '.repeat(LINE - left.length - right.length) + right]
      }
      const lines: string[] = []
      let rest = left
      while (rest.length > LINE) { lines.push(rest.slice(0, LINE)); rest = rest.slice(LINE) }
      if (rest && rest.length + 1 + right.length <= LINE) {
        lines.push(rest + ' '.repeat(LINE - rest.length - right.length) + right)
      } else {
        if (rest) lines.push(rest)
        lines.push(' '.repeat(Math.max(0, LINE - right.length)) + right)
      }
      return lines
    }
    const rule = '-'.repeat(LINE)

    const { topText, bottomText, footer2Text } = parseBillTemplate(billHeaderTpl)
    // A buffet sharing the order with the guest's own items prints with no
    // amount, and the printed total is what the guest actually hands over. A
    // buffet on its own prints and totals normally — that slip is the record of
    // the cover the hotel is being charged for.
    const hidden = hotelBuffetPriceHidden(order.restaurant_id, items.map(i => ({
      name: i.dish_name, category: dishes.find(d => d.id === i.dish_id)?.category,
    })))
    const billLines = items.map((i, idx) => ({ item: i, hidePrice: hidden[idx] }))
    const { totalAmount } = calcTotals(
      billLines.map(l => ({
        dishPrice: l.hidePrice ? 0 : l.item.dish_price,
        qty: l.item.qty,
        discountPercent: l.item.discount_percent,
      })),
    )
    const now = new Date()
    const dt  = now.toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    const isTakeaway = !order.table_id
    const orderType  = isTakeaway ? 'Take Away' : 'Dine In'
    const server     = order.created_by_name ?? '—'
    const station    = (order.branch_id ? branches.find(b => b.id === order.branch_id)?.name : null) ?? restaurantName ?? ''
    const orderNo    = order.order_number ?? ''

    // ESC/POS path: raw thermal bytes over TCP (network printer IP) or into
    // the local Windows queue (thermal styling enabled in the Printers tab).
    // Falls back to the OS default printer when no bill printer is selected.
    const escposPrinterName = billEscposMode
      ? (billPrinter || printers.find(p => p.isDefault && !isVirtualPrinter(p.name))?.name || '')
      : ''
    if (billNetworkPrinter?.ip || escposPrinterName) {
      printBillRaw({
        topText, bottomText, footer2Text, server, station, orderNo, orderType,
        tableName: isTakeaway ? null : (order.table_name ?? 'Table'),
        dt,
        items: billLines.map(l => ({
          qty: l.item.qty, name: l.item.dish_name, unitPrice: l.item.dish_price,
          // The raw thermal bill is a wholly separate renderer from the HTML
          // one, and it was never told about discounts — so a venue printing
          // ESC/POS (which is every venue with a thermal printer) handed the
          // guest a bill at full price while the screen showed the discount.
          discountPercent: l.item.discount_percent ?? null,
          notes: l.item.notes ?? null,
          // Suppresses the amount column entirely — a zero would read as a
          // free item rather than a line the hotel is settling.
          noPrice: l.hidePrice,
        })),
        totalAmount,
        columns: LINE,
        ...(billNetworkPrinter?.ip
          ? { ip: billNetworkPrinter.ip, port: billNetworkPrinter.port }
          : { printerName: escposPrinterName }),
      }).then(result => {
        if (!result.ok) setSubmitError(`Bill print failed: ${result.error ?? 'unknown error'}`)
      }).catch((err: Error) => setSubmitError(`Bill print failed: ${err.message}`))
      return
    }

    // HTML / system-printer path: plain monospace lines (see comment above).
    const tmpl = (l: string): string => {
      const display = l.replace(/\*\*(.+?)\*\*/g, '$1').replace(/_(.+?)_/g, '$1')
      const pad = display.length >= LINE ? '' : ' '.repeat(Math.floor((LINE - display.length) / 2))
      const inner = escHtml(l)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/_(.+?)_/g, '<i>$1</i>')
      return `<div class="line">${pad}${inner || ' '}</div>`
    }
    const ln = (s: string, bold = false) =>
      `<div class="${bold ? 'line bold' : 'line'}">${escHtml(s) || ' '}</div>`

    const divLines: string[] = []
    for (const l of (topText || 'RECEIPT').split('\n')) divLines.push(tmpl(l.trim()))
    divLines.push(ln(rule))
    for (const s of cols(`Server: ${server}`, station ? `Station: ${station}` : '')) divLines.push(ln(s))
    divLines.push(ln(rule))
    for (const s of cols(`Order #: ${orderNo}`, orderType)) divLines.push(ln(s))
    if (!isTakeaway) divLines.push(ln(`Table: ${order.table_name ?? 'Table'}`))
    divLines.push(ln(rule))
    for (const { item: i, hidePrice } of billLines) {
      // A hidden buffet gets no amount at all — passing '' to cols() drops the
      // whole right-hand column for that line.
      for (const s of cols(`${i.qty} ${i.dish_name.toUpperCase()}`, hidePrice ? '' : fmt2(lineNetAmount(i)))) divLines.push(ln(s))
      // The discount prints under its line so the guest can see what came off
      // and why the figure is not the menu price. Suppressed on a hidden buffet
      // line, which shows no amount at all.
      if (i.discount_percent && !hidePrice) {
        for (const s of cols(`  less ${i.discount_percent}%`, `-${fmt2(i.dish_price * i.qty - lineNetAmount(i))}`)) divLines.push(ln(s))
      }
      if (i.notes) divLines.push(ln(`  > ${i.notes}`))
    }
    divLines.push(ln(rule))
    for (const s of cols('TOTAL:', `Rwf ${fmtRWF(totalAmount)}`)) divLines.push(ln(s, true))
    divLines.push(ln(rule))
    divLines.push(ln(center(`>> ${orderNo} <<`)))
    divLines.push(ln(center(dt)))
    for (const l of (bottomText && bottomText.trim() ? bottomText : 'Thank you for dining with us!').split('\n')) divLines.push(tmpl(l.trim()))
    divLines.push(ln(center('Powered by Magnify')))
    // Footer 2 (from the bill editor) prints below "Powered by Magnify" —
    // typically blank lines the manager adds to push the footer up past the
    // cutter on printers that need extra feed.
    if (footer2Text) for (const l of footer2Text.split('\n')) divLines.push(tmpl(l.trim()))
    // Text-only drivers ignore CSS heights entirely — paper only advances on
    // literal line feeds, so blank lines are what push the footer past the
    // cutter. (This is also why manual blank lines in the template used to be
    // the only way to feed paper.)
    for (let k = 0; k < 8; k++) divLines.push(ln(' '))

    // Font size scales down as the column count goes up so LINE characters
    // always fit the 72mm printable width on graphics drivers (Courier's
    // advance width is 0.6em). Text-only drivers ignore this and use the
    // printer's own font, where LINE was chosen to match its real columns.
    const fontPx = Math.max(8, Math.min(14, Math.floor(272 / (LINE * 0.6))))
    const barcodeEl = orderNo ? code128svg(orderNo) : ''
    // Whole bill prints bold — thin regular strokes come out grey on thermal
    // heads (the kitchen tickets read well because their text is bold). And no
    // custom page-size override (no data-doc): the driver sizes the page from
    // content exactly like the kitchen tickets, which feed and cut correctly;
    // forcing an exact page height makes some drivers squeeze the content
    // vertically (overlapping lines, even thinner strokes).
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bill ${escHtml(orderNo || '')}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Courier New',monospace;font-weight:bold;font-size:${fontPx}px;width:80mm;padding:5mm 4mm 0;color:#000}
.line{white-space:pre;line-height:1.35;display:block;min-height:1.35em}
.bold{font-weight:bold}
b{font-weight:bold}
i{font-style:italic}
@media print{@page{margin:0;size:80mm auto}}
</style></head><body>
<div id="bill-content">${divLines.join('')}</div>
${barcodeEl}
</body></html>`
    printHtml(html, 0, billPrinter)
  }

  async function printKitchenTickets(order: Order, cart: CartItem[], rName: string) {
    const byBranch = new Map<string, { branchName: string; branchType: string; items: CartItem[] }>()
    for (const ci of cart) {
      // The line's OWN station first, then the dish lookup. `dishes` only holds
      // the station this terminal is signed in to (getDishes(activeBranch)), so
      // a line rung up elsewhere — every tablet order pushed from here — finds
      // no dish, falls to '__none__', and every ticket lands on the bill
      // printer instead of the kitchen that has to cook it.
      const dish = dishes.find(d => d.id === ci.dishId)
      const bId = ci.branchId ?? dish?.branch_id ?? '__none__'
      const branch = branches.find(b => b.id === bId)
      const bName = branch?.name ?? 'Kitchen'
      const bType = branch?.type ?? 'kitchen'
      if (!byBranch.has(bId)) byBranch.set(bId, { branchName: bName, branchType: bType, items: [] })
      byBranch.get(bId)!.items.push(ci)
    }
    // Same "Generic / Text Only"-class driver problem as the bill (see printBill
    // above): flex/gap/height are silently dropped, so the old .row/.item layout
    // ran qty, dish name and the Server/Station pair together with no space at
    // all. Laid out as monospace TEXT instead — padded columns, explicit spaces
    // between fields — so it reads correctly on both text-only and graphics
    // drivers.
    const LINE = billColumns
    const center = (s: string) =>
      s.length >= LINE ? s : ' '.repeat(Math.floor((LINE - s.length) / 2)) + s
    const cols = (left: string, right: string): string[] => {
      if (!right) return [left]
      if (left.length + 1 + right.length <= LINE) {
        return [left + ' '.repeat(LINE - left.length - right.length) + right]
      }
      const lines: string[] = []
      let rest = left
      while (rest.length > LINE) { lines.push(rest.slice(0, LINE)); rest = rest.slice(LINE) }
      if (rest && rest.length + 1 + right.length <= LINE) {
        lines.push(rest + ' '.repeat(LINE - rest.length - right.length) + right)
      } else {
        if (rest) lines.push(rest)
        lines.push(' '.repeat(Math.max(0, LINE - right.length)) + right)
      }
      return lines
    }
    const rule = '-'.repeat(LINE)
    const ln = (s: string, bold = false) =>
      `<div class="${bold ? 'line bold' : 'line'}">${escHtml(s) || ' '}</div>`

    const now      = new Date()
    const dateStr  = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`
    const timeStr  = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })
    const isTakeaway = !order.table_id
    const orderType  = isTakeaway ? 'Take Away' : 'Dine In'
    const stars      = '*'.repeat(LINE)
    const fontPx = Math.max(8, Math.min(14, Math.floor(272 / (LINE * 0.6))))
    // The print queue (printHtml) serialises these tickets, so no per-ticket
    // wall-clock stagger is needed — each just follows the previous in order.
    // The number the cook reads off the paper. It is allocated per station and
    // restarts at 1 each business day, so "KOT #0006" means the sixth slip that
    // kitchen has seen today — not the sixth line of this order, which is what
    // the old per-order index counted and which told nobody anything.
    const businessDate = await currentBusinessDateISO()
    for (const [bId, group] of byBranch) {
      const deviceName = resolveStationPrinter(printerMap, billPrinter, bId === '__none__' ? null : bId)
      // resolveStationPrinter falls back to the bill printer when a station has
      // no printer of its own, and that fallback used to be silent: every
      // ticket came out of the one machine and the station mapping looked
      // broken when it was simply empty. Say which station is unmapped, so it
      // can be fixed in Printers instead of guessed at.
      if (bId !== '__none__' && !printerMap[bId]) {
        setSubmitError(`No printer set for ${group.branchName} — printed on the bill printer. Assign one in Printers.`)
      }
      const station = group.branchType === 'bar' ? 'BAR' : 'KITCHEN'
      // KOT for a kitchen, BOT for a bar. Padded to four digits so the numbers
      // line up on the rail — the padding is display only and a busy day is
      // free to run past 9999.
      const kind = station === 'BAR' ? 'BOT' : 'KOT'
      // The number is record-keeping; the slip reaching the pass is not. If
      // allocation fails — the table missing because a migration has not run,
      // the disk full — the ticket must STILL print, or the kitchen never
      // learns about food a guest has already ordered. Print unnumbered and
      // log it rather than letting the whole run die.
      let seq: number | null = null
      try {
        seq = await recordKitchenTicket({
          orderId: order.id,
          branchId: bId === '__none__' ? null : bId,
          kind,
          businessDate,
        })
      } catch (err) {
        void logError('print', 'Ticket number allocation failed — printing unnumbered', {
          orderId: order.id,
          branchId: bId,
          error: (err as Error).message,
        })
      }
      const ticketNo = seq === null ? `${kind} (unnumbered)` : `${kind} #${String(seq).padStart(4, '0')}`

      // ESC/POS path — the same raw delivery the bill uses. A thermal printer
      // on the "Generic / Text Only" driver cannot render the GDI/HTML page
      // below: it feeds the paper and prints nothing at all. Raw bytes are the
      // only way any text reaches that hardware, so when thermal styling is on
      // (or a network thermal printer is configured) tickets go out raw too.
      const escposTicketPrinter = billEscposMode
        ? (deviceName || printers.find(p => p.isDefault && !isVirtualPrinter(p.name))?.name || '')
        : ''
      // A station with its own local printer keeps it; the network bill printer
      // is only the target when no local queue was resolved for this station.
      const useNetwork = !escposTicketPrinter && !deviceName && !!billNetworkPrinter?.ip
      if (escposTicketPrinter || useNetwork) {
        const rawTicket = (copy: 'station' | 'waiter') => ({
          branchName: group.branchName || rName || 'Kitchen',
          station, copy,
          server: order.created_by_name ?? '-',
          orderType,
          tableName: isTakeaway ? null : (order.table_name ?? 'Table'),
          dateStr, timeStr,
          ticketNo,
          orderNo: order.order_number ?? '',
          items: group.items.map(i => ({ qty: i.qty, name: i.dishName, note: i.note ?? null })),
          columns: LINE,
          ...(useNetwork
            ? { ip: billNetworkPrinter!.ip, port: billNetworkPrinter!.port }
            : { printerName: escposTicketPrinter }),
        })
        // Chain onto the shared print queue so the station copy fully lands
        // (and the printer cuts) before the waiter copy starts — two physical
        // slips, in order, exactly as the HTML path behaves.
        for (const copy of ['station', 'waiter'] as const) {
          electronPrintQueue = electronPrintQueue
            .then(() => printTicketRaw(rawTicket(copy)))
            .then(result => {
              if (!result.ok) setSubmitError(`Ticket print failed: ${result.error ?? 'unknown error'}`)
            })
            .catch((err: Error) => setSubmitError(`Ticket print failed: ${err.message}`))
            .then(() => new Promise<void>(res => setTimeout(res, PRINT_GAP_MS)))
        }
        continue
      }

      // Each station's ticket prints twice: the station's own copy, then the
      // waiter's copy as a delivery checklist. Queued as two separate print
      // jobs so the printer cuts after the first before the second starts —
      // two physical slips, not one long one. Both carry the same Ticket #;
      // only the copy line and the tick boxes differ.
      const buildTicket = (copy: 'station' | 'waiter'): string => {
        const isWaiter = copy === 'waiter'
        const divLines: string[] = []
        divLines.push(ln(center(`*** ${group.branchName || rName || 'Kitchen'} ***`), true))
        divLines.push(ln(center(isWaiter ? '--- WAITER CHECKLIST ---' : `--- ${station} COPY ---`), true))
        divLines.push(ln(rule))
        for (const s of cols(`Server: ${order.created_by_name ?? '—'}`, station)) divLines.push(ln(s, true))
        divLines.push(ln(center(orderType), true))
        for (const s of cols(dateStr, timeStr)) divLines.push(ln(s))
        divLines.push(ln(rule))
        if (!isTakeaway) {
          divLines.push(ln(`Table: ${order.table_name ?? 'Table'}`, true))
          divLines.push(ln(rule))
        }
        for (const i of group.items) {
          // Explicit spaces between qty and dish name — a flex `gap` collapses to
          // nothing on text-only drivers and the two run together as one word.
          // The waiter's copy gets a box per line to tick off on delivery.
          const label = `${isWaiter ? '[ ] ' : ''}${i.qty}x  ${i.dishName.toUpperCase()}`
          for (const s of cols(label, '')) divLines.push(ln(s, true))
          if (i.note) divLines.push(ln(`  > ${i.note}`))
        }
        divLines.push(ln(rule))
        divLines.push(ln(center(stars)))
        divLines.push(ln(center(ticketNo), true))
        divLines.push(ln(center(`Order #: ${order.order_number ?? ''}`)))
        divLines.push(ln(center(stars)))
        // Text-only drivers ignore CSS height entirely — paper only advances on
        // literal line feeds, and some drivers also trim a fully-blank tail
        // before cutting, which is why tickets were coming out short/stuck. Blank
        // lines plus one visible dot at the very end push real paper past the
        // tear bar and stop the tail from being trimmed away.
        for (let k = 0; k < 8; k++) divLines.push(ln(' '))
        divLines.push(ln(center('.')))

        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Ticket ${escHtml(order.order_number ?? '')} ${escHtml(isWaiter ? 'WAITER' : station)}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Courier New',monospace;font-weight:bold;font-size:${fontPx}px;width:80mm;padding:20mm 4mm 0;color:#000}
.line{white-space:pre;line-height:1.35;display:block;min-height:1.35em}
.bold{font-weight:bold}
@media print{@page{margin:0;size:80mm auto}}
</style></head><body>
<div>${divLines.join('')}</div>
</body></html>`
      }

      printHtml(buildTicket('station'), 0, deviceName)
      printHtml(buildTicket('waiter'), 0, deviceName)
    }
  }

  // ── Discounts ──────────────────────────────────────────────────────────────

  // Write the discount a supervisor has just approved. The percentage was typed
  // before the PIN, so by the time this runs both halves are in hand.
  async function applyApprovedDiscount(approvedBy: string) {
    if (!discountTarget) return
    const raw = Number(discountPct)
    // Blank or 0 clears the discount — that is how a mistake gets undone, and it
    // needs the same approval as setting one.
    const pct = Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : null
    try {
      await setItemDiscount(discountTarget.orderId, discountTarget.item.id, pct)
      await recomputeOrderTotals(discountTarget.orderId)
      await loadPOS()
      setConfirmSuccess(
        pct === null
          ? `Discount removed · approved by ${approvedBy}`
          : `${pct}% off ${discountTarget.item.dish_name} · approved by ${approvedBy}`,
      )
      setTimeout(() => setConfirmSuccess(null), 4000)
      pushSync().catch(() => {})
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not apply the discount')
    } finally {
      setDiscountTarget(null)
      setDiscountAwaitingPin(false)
      setDiscountPct('')
    }
  }

  // Re-derive an order's stored totals from its lines, discounts included, so
  // the pending card, the bill and the payment all quote the same figure. The
  // server recomputes independently from the same percentages on push.
  async function recomputeOrderTotals(orderId: string) {
    const items = await getOrderItems(orderId)
    const active = items.filter(i => i.status === 'ACTIVE')
    const subtotal = active.reduce((sum, i) => sum + lineNetAmount(i), 0)
    await updateOrder(orderId, {
      subtotal_amount: subtotal,
      vat_amount: 0,
      total_amount: subtotal,
    })
  }

  // Move an approved line onto a fresh bill at another table.
  //
  // The new bill keeps the ORIGINAL order's waiter, not whoever is signed in:
  // the sale still belongs to the person who took it, exactly as it does when a
  // supervisor settles someone else's table.
  async function applyApprovedMove(approvedBy: string) {
    if (!moveTarget) return
    const source = pendingOrders.find(o => o.id === moveTarget.orderId)
    const table  = tables.find(t => t.id === moveTableId)
    if (!source || !table) { setSubmitError('Pick a table to move this item to.'); return }
    try {
      const now      = new Date().toISOString()
      const newId    = crypto.randomUUID()
      const orderNum = `WA-${newId.replace(/-/g, '').slice(-8).toUpperCase()}`
      const net      = lineNetAmount(moveTarget.item)

      await moveOrderItemToNewOrder({
        sourceOrderId: source.id,
        sourceItemId:  moveTarget.item.id,
        newOrder: {
          ...source,
          id: newId,
          order_number: orderNum,
          table_id: table.id,
          table_name: table.name,
          status: 'PENDING',
          payment_method: null,
          subtotal_amount: net,
          vat_amount: 0,
          total_amount: net,
          // A moved line is not a new cover count — the guests were already
          // counted on the bill it came from.
          guest_count: null,
          served_at: null,
          paid_at: null,
          canceled_at: null,
          cancel_reason: null,
          settled_by_name: null,
          no_charge_reason: null,
          comped_amount: null,
          tickets_pushed_at: null,
          synced: 0,
          created_at: now,
          updated_at: now,
        },
        newItem: { ...moveTarget.item, id: crypto.randomUUID(), order_id: newId, created_at: now, updated_at: now },
      })

      // The source bill has to be re-totalled: its retired line must stop being
      // charged for. recomputeOrderTotals counts ACTIVE lines only.
      await recomputeOrderTotals(source.id)
      await logInfo('order', 'Item moved to another table', {
        fromOrder: source.order_number,
        toOrder: orderNum,
        table: table.name,
        item: moveTarget.item.dish_name,
        qty: moveTarget.item.qty,
        approvedBy,
      })
      await loadPOS()
      setMoveTarget(null)
      setMoveAwaitingPin(false)
      setMoveTableId('')
      setConfirmSuccess(`${moveTarget.item.dish_name} moved to ${table.name} as ${orderNum} · approved by ${approvedBy}`)
      setTimeout(() => setConfirmSuccess(null), 4000)
      pushSync().catch(() => {})
    } catch (err) {
      setMoveAwaitingPin(false)
      setSubmitError(`Could not move the item: ${(err as Error).message}`)
    }
  }

  // ── Joining orders ─────────────────────────────────────────────────────────

  // Whether the chosen orders were all taken by the same waiter. Combining one
  // waiter's own bills is routine; pulling another waiter's table into yours
  // moves who gets credited for the sale, so that takes a supervisor.
  function joinNeedsApproval(ids: string[]): boolean {
    const waiters = new Set(
      ids.map(id => (pendingOrders.find(o => o.id === id)?.created_by_name ?? '').trim().toLowerCase()),
    )
    return waiters.size > 1
  }

  async function performJoin(approvedBy?: string) {
    const ids = [...joinIds]
    if (ids.length < 2) return
    // The oldest order survives: it carries the number the guest was quoted
    // first, and its shift and business day are the ones the sale belongs to.
    const chosen = ids
      .map(id => pendingOrders.find(o => o.id === id))
      .filter((o): o is Order => Boolean(o))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    const target = chosen[0]
    const sources = chosen.slice(1)
    if (!target || !sources.length) return
    try {
      await mergeOrdersLocal(target.id, sources.map(o => o.id))
      await recomputeOrderTotals(target.id)
      await loadPOS()
      setJoinMode(false)
      setJoinIds([])
      setConfirmSuccess(
        `${chosen.length} orders joined into ${target.order_number}` +
        (approvedBy ? ` · approved by ${approvedBy}` : ''),
      )
      setTimeout(() => setConfirmSuccess(null), 4000)
      pushSync().catch(() => {})
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Could not join those orders')
    } finally {
      setJoinAwaitingPin(false)
    }
  }

  // ── Order lifecycle ──

  // Load the order being edited (requested from the Pending tab) into the POS:
  // jump to its table, show its sent items locked, and take new items in the cart.
  useEffect(() => {
    if (mode !== 'pos') return
    if (!editingOrderId) {
      setEditingOrder(null)
      setEditingItems([])
      return
    }
    let cancelled = false
    void (async () => {
      const [order, items] = await Promise.all([getOrderById(editingOrderId), getOrderItems(editingOrderId)])
      if (cancelled) return
      if (!order || order.status !== 'PENDING') {
        setSubmitError('This order can no longer be edited.')
        onEditDone?.()
        return
      }
      setEditingOrder(order)
      setEditingItems(items.filter(i => i.status === 'ACTIVE'))
      setSelectedTableKey(order.table_id ?? 'takeaway')
      setShowPanel('dishes')
      setSubmitError(null)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingOrderId, mode])

  function cancelEditOrder() {
    setLocalCart(prev => ({ ...prev, [selectedTableKey]: [] }))
    setSubmitError(null)
    onEditDone?.()
  }

  // Append the cart to the order being edited. Existing items are untouched;
  // ONLY the new items print kitchen tickets. Totals are recomputed and the
  // order re-queues for push (updateOrder marks it unsynced).
  async function appendToOrder() {
    const cart = localCart[selectedTableKey] ?? []
    if (!editingOrder) return
    if (!cart.length) {
      setSubmitError('No new items yet. Tap a dish to add it first.')
      return
    }
    if (orderSubmitLockRef.current) {
      setSubmitError('Order is already being updated — please wait.')
      return
    }

    setSubmitError(null)
    setConfirmSuccess(null)
    orderSubmitLockRef.current = true
    setConfirmingOrder(true)
    try {
      const now = new Date().toISOString()
      const newItems: OrderItem[] = cart.map((item) => ({
        id:         createId(),
        order_id:   editingOrder.id,
        dish_id:    item.dishId,
        dish_name:  item.dishName,
        dish_price: item.dishPrice,
        qty:        item.qty,
        status:     'ACTIVE',
        notes:      item.note ?? null,
        branch_id:  dishes.find(d => d.id === item.dishId)?.branch_id ?? null,
        discount_percent: null,
        created_at: now,
        updated_at: now,
      }))
      await addOrderItems(newItems)

      const combined = [
        ...editingItems.map(i => ({ dishPrice: i.dish_price, qty: i.qty })),
        ...cart.map(i => ({ dishPrice: i.dishPrice, qty: i.qty })),
      ]
      const { subtotal, vatAmount, totalAmount } = calcTotals(combined)
      await updateOrder(editingOrder.id, { subtotal_amount: subtotal, vat_amount: vatAmount, total_amount: totalAmount })

      await logInfo('order', 'Order edited: items appended', {
        orderId: editingOrder.id,
        orderNumber: editingOrder.order_number,
        addedItems: newItems.length,
        newTotal: totalAmount,
      })

      // Tickets for the NEW items only — the kitchen already has the rest.
      await printKitchenTickets(editingOrder, cart, restaurantName ?? '')

      await loadPOS()
      setLocalCart(prev => ({ ...prev, [selectedTableKey]: [] }))
      setConfirmSuccess(`${editingOrder.order_number} updated — ${newItems.length} new item${newItems.length === 1 ? '' : 's'} sent to kitchen`)
      setTimeout(() => setConfirmSuccess(null), 4000)
      onEditDone?.()

      pushSync().catch(() => {})
    } catch (err) {
      void logError('order', 'Append to order failed', {
        orderId: editingOrder.id,
        error: normalizeErrorForLog(err),
      })
      setSubmitError('Could not update the order — try again.')
    } finally {
      orderSubmitLockRef.current = false
      setConfirmingOrder(false)
    }
  }

  async function confirmOrder(waiterName: string) {
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

    // ── Guard 3: restaurant config ───────────────────────────────────────────
    const name = waiterName
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
      // Items keep their real price even when the hotel buffet is on credit —
      // that revenue IS earned, it just settles as a receivable from the hotel
      // instead of cash at the table (see services/hotelBuffet.ts).
      const { subtotal, vatAmount, totalAmount } = calcTotals(cart)

      // Covers are optional: a blank or nonsense box stores null, not 0, so the
      // manager's average is built only from tables where a real count was given.
      const rawGuests = Number(guestsByTable[selectedTableKey] ?? '')
      const parsedGuestCount = Number.isInteger(rawGuests) && rawGuests > 0 ? rawGuests : null

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

      // Stamp the order with the open shift so its sale lands on the shift's
      // business day, whatever time it's eventually paid. Null when this venue
      // runs without shifts, or as a fallback — such orders report by paidAt.
      const activeShift = await getActiveShift()

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
        guest_count:        parsedGuestCount,
        served_at:          null,
        paid_at:            null,
        canceled_at:        null,
        cancel_reason:      null,
        // All three are settlement detail, so nothing is known at ring-up: who
        // closed the bill, and — if it is comped — why and for how much.
        settled_by_name:    null,
        no_charge_reason:   null,
        comped_amount:      null,
        // Set only if the order is later settled on credit.
        ar_customer_name:   null,
        ar_customer_phone:  null,
        shift_id:           activeShift?.id ?? null,
        business_date:      activeShift?.business_date ?? null,
        // Which app took it. The till reads this to decide whether the kitchen
        // tickets still need pushing to paper by hand.
        source:             ORDER_SOURCE,
        merged_into_id:     null,
        tickets_pushed_at:  null,
        synced:             0,
        sync_error:         null,
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
        notes:      item.note ?? null,
        branch_id:  dishes.find(d => d.id === item.dishId)?.branch_id ?? null,
        discount_percent: null,
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

      await printKitchenTickets(order, cart, restaurantName ?? '')

      // ── Reload BEFORE clearing cart so the panel never flashes empty ──────
      await loadPOS()
      setLocalCart(prev => ({ ...prev, [selectedTableKey]: [] }))
      setGuestsByTable(prev => ({ ...prev, [selectedTableKey]: '' }))
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

  // Send a tablet-taken order's tickets to the kitchen printers.
  //
  // The tablet has no way to print — no spooler, no raw socket, no print plugin
  // — so an order it rang up reaches the kitchen only when someone here pushes
  // it. Identical to what confirming an order does on this till: the same
  // grouping by each dish's own station, so every kitchen and the bar get only
  // their own lines.
  //
  // The pushed stamp is local. It records that THIS terminal's printers ran, and
  // deliberately does not sync: paper coming out here says nothing about a
  // second till, and it must never re-push the order to the server.
  async function pushToKitchen(order: Order, items: OrderItem[]) {
    // Recover the station for any line that arrived without one.
    //
    // Until today the sync wrote incoming order items WITHOUT branch_id — the
    // server sent it and the till dropped it — so every order that reached this
    // terminal from a tablet has null there and grouped under '__none__', which
    // resolves to the bill printer. That is why an order rung up here printed to
    // the right kitchens and the same order rung up on a tablet did not.
    //
    // Storing the column is fixed, but INSERT OR IGNORE never revisits a row, so
    // orders already synced would stay wrong for ever. The dish itself knows
    // which station it belongs to, and this device holds every station's dishes
    // — getDishes() without a branch returns the lot, the branch filter is only
    // applied when the menu is displayed. So the answer is already here.
    const allDishes = await getDishes()
    const stationOfDish = new Map(allDishes.map(d => [d.id, d.branch_id]))

    await printKitchenTickets(
      order,
      items.map(i => ({
        dishId: i.dish_id, dishName: i.dish_name, dishPrice: i.dish_price,
        qty: i.qty, note: i.notes ?? undefined,
        // The line's own stamp first — it is the station as it was when the
        // order was rung up, and survives a dish being moved since. The dish's
        // current station is the fallback for lines that never got one.
        branchId: i.branch_id ?? stationOfDish.get(i.dish_id) ?? null,
      })),
      restaurantName ?? '',
    )
    await markTicketsPushed(order.id)
    await loadPOS()
  }

  // Confirm a guest QR order (status UNCONFIRMED) → PENDING so it reaches the kitchen.
  // Records the confirming waiter (from their order code) while preserving the guest's name.
  async function confirmIncomingOrder(orderId: string, waiterName: string) {
    const order = pendingOrders.find(o => o.id === orderId)
    const items = orderItemsMap[orderId] ?? []
    try {
      const base = order?.created_by_name?.trim() || 'Guest QR Order'
      const createdByName = /confirmed by/i.test(base) ? base : `${base} · confirmed by ${waiterName}`
      await updateOrder(orderId, { status: 'PENDING', created_by_name: createdByName })
      // Same station recovery as pushToKitchen: a guest QR order reaches this
      // till by sync, and older syncs stored no branch_id on its lines.
      const allDishes = await getDishes()
      const stationOfDish = new Map(allDishes.map(d => [d.id, d.branch_id]))
      if (order) {
        await printKitchenTickets(
          { ...order, created_by_name: createdByName },
          // branchId: the station the line was rung up on. A guest QR order can
          // hold dishes from several stations, and this terminal only has its
          // own station's dishes loaded, so without it those tickets all land
          // on the bill printer.
          items.map(i => ({
            dishId: i.dish_id, dishName: i.dish_name, dishPrice: i.dish_price,
            qty: i.qty, note: i.notes ?? undefined,
            branchId: i.branch_id ?? stationOfDish.get(i.dish_id) ?? null,
          })),
          restaurantName ?? '',
        )
      }
      await loadPOS()
      setConfirmSuccess(`${order?.order_number ?? 'Order'} sent to kitchen`)
      setTimeout(() => setConfirmSuccess(null), 4000)
      pushSync().catch(() => {})
    } catch (err) {
      void logError('order', 'Confirm incoming order failed', { orderId, error: normalizeErrorForLog(err) })
      setSubmitError(err instanceof Error ? err.message : 'Failed to confirm order')
    }
  }

  async function markOrderServed(orderId: string) {
    await updateOrder(orderId, { served_at: new Date().toISOString() })
    await loadPOS()
    pushSync().catch(() => {})
  }

  async function collectPayment(orderId: string) {
    const order = pendingOrders.find(o => o.id === orderId)
    if (!order || paymentLockRef.current) return
    paymentLockRef.current = true
    setPayingSaving(true)
    try {
      const onCredit = payMethod === 'Credit'
      const comped   = payMethod === NO_CHARGE
      // What the table was worth at menu prices, discounts included — the same
      // figure the card and the bill quote. On a comp this is the value written
      // off, and it is the only place that value survives, because the order's
      // own totals go to zero below.
      const items    = orderItemsMap[order.id] ?? []
      // Sirocco's hotel buffet is owed by the hotel, not the guest, so comping
      // the guest's bill does not write it off — it is not part of what was
      // comped. The server recomputes this from the pushed lines and its figure
      // wins; this one keeps the till's own record honest in the meantime.
      const compBuffet = hotelCreditLines(order.restaurant_id, items.map(i => ({ name: i.dish_name })))
      const menuValue = items.reduce((sum, i, idx) => sum + (compBuffet[idx] ? 0 : lineNetAmount(i)), 0)
      await updateOrder(order.id, {
        status:         'PAID',
        payment_method: payMethod,
        paid_at:        new Date().toISOString(),
        // A comp closes at zero. Zeroing the order itself — rather than asking
        // every report to learn what 'No Charge' means — is what keeps revenue,
        // APC and the sales reports honest by construction.
        ...(comped
          ? {
              subtotal_amount:  0,
              vat_amount:       0,
              total_amount:     0,
              comped_amount:    menuValue,
              no_charge_reason: noChargeReason.trim(),
            }
          : { comped_amount: null, no_charge_reason: null }),
        // Who closed the bill, recorded only when that is not the waiter whose
        // name is already on the order. created_by_name is deliberately left
        // alone: the sale belongs to the waiter who took the table.
        ...(waiterName.trim() && !ownedByMe(order) ? { settled_by_name: waiterName.trim() } : {}),
        // Stored on the order so the debt survives offline and syncs with it.
        // Cleared on any non-credit tender so a mistyped name can't cling to a
        // tab that was ultimately settled in cash.
        ar_customer_name:  onCredit ? arCustomerName.trim() : null,
        ar_customer_phone: onCredit ? (arCustomerPhone.trim() || null) : null,
      })
      // The bill is printed on demand via the "Print Bill" button when the
      // guest asks for it. Confirming payment must NOT re-print it — that
      // wasted a second slip of paper on every settled order.
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
      setPayingOrderId(null)
      setPayMethod('Cash')
      setArCustomerName('')
      setArCustomerPhone('')
      setNoChargeReason('')
    } catch {}
    finally {
      paymentLockRef.current = false
      setPayingSaving(false)
    }
  }

  // CancelModal (module-scope) handles the PIN/reason entry and the DB write;
  // this runs the POS-side side effects once a cancellation is approved.
  function handleOrderCanceled(approvedBy: string, tableKey: string) {
    setLocalCart(prev => ({ ...prev, [tableKey]: [] }))
    setSelectedTableKey('takeaway')
    setShowPanel('dishes')
    setConfirmSuccess(`Order canceled · approved by ${approvedBy}`)
    setTimeout(() => setConfirmSuccess(null), 5000)
    loadPOS()
    pushSync().catch(() => {})
  }

  // ── Derived values ──

  // Tab order: "add-ons" categories always last, everything else alphabetical
  // (e.g. Tiamo → Pasta, Sauces, Add-ons).
  const isAddonCat = (c: string) => /add[\s-]?ons?/i.test(c)
  const categories = (Array.from(new Set(dishes.map(d => d.category).filter(Boolean))) as string[])
    .sort((a, b) => (isAddonCat(a) !== isAddonCat(b) ? (isAddonCat(a) ? 1 : -1) : a.localeCompare(b)))

  const filteredDishes = dishes.filter(d => {
    if (selectedCategory && d.category !== selectedCategory) return false
    if (searchQuery) return d.name.toLowerCase().includes(searchQuery.toLowerCase())
    return true
  })

  // The Menu panel is a build-only cart; confirmed orders live in the Pending Orders tab.
  const cartItems      = localCart[selectedTableKey] ?? []
  const isBuilding     = cartItems.length > 0
  const { totalAmount } = calcTotals(cartItems)
  // Every hotel buffet is settled by the hotel as a receivable, so it is never
  // collected at the table. Split out here so the waiter reads the figure they
  // actually take from the guest.
  const cartCredits    = hotelCreditLines(restaurantId, cartItems.map(i => ({
    name: i.dishName, category: dishes.find(d => d.id === i.dishId)?.category,
  })))
  const cartCreditAmount = cartItems.reduce((s, i, idx) => s + (cartCredits[idx] ? i.dishPrice * i.qty : 0), 0)
  const cartDueAtTable   = totalAmount - cartCreditAmount
  const tableNumber        = selectedTableKey === 'takeaway' ? 'Takeaway' : (tables.find(t => t.id === selectedTableKey)?.name ?? 'Table')
  const activeTableKeys    = new Set(pendingOrders.map(o => o.table_id ?? 'takeaway'))
  // Terminals are shared: waiter A steps away and waiter B signs in with their
  // own order code. Every active order stays VISIBLE to both — B needs to see
  // that table 7 is being served — but B cannot act on A's orders: the card
  // renders read-only, with no Served / Pay / Add / Cancel buttons.
  //
  // Ownership is created_by_name, because that is the waiter; the Staff row
  // behind the terminal is the shared screen account and identifies nobody.
  // Treated as everyone's (fully actionable): guest QR orders awaiting
  // confirmation, and orders with no recorded waiter, which would otherwise
  // be stranded read-only on every terminal with no way to settle them.
  const ownedByMe = (o: Order): boolean => {
    if (!waiterName.trim()) return true          // no waiter signed in — full access
    if (o.status === 'UNCONFIRMED') return true  // unclaimed guest QR order
    const who = o.created_by_name?.trim().toLowerCase()
    if (!who) return true
    const me = waiterName.trim().toLowerCase()
    if (who === me) return true
    // A confirmed guest order reads "Guest QR Order · confirmed by <waiter>".
    // Compare the whole trailing name, so "Sam" does not match "Samuel".
    const confirmedBy = who.match(/confirmed by (.+)$/)
    return confirmedBy ? confirmedBy[1].trim() === me : false
  }
  // A supervisor settles, edits, discounts, fires and cancels any table on the
  // floor. That is the whole point of their code: a waiter who has gone home,
  // or is stuck at another table, no longer strands a live bill. Attribution is
  // untouched — created_by_name still names the waiter who took the order, so
  // the sale stays theirs in every report; settled_by_name records who closed it.
  const ownsOrder = (o: Order): boolean => isSupervisor || ownedByMe(o)
  // True only for the cards a supervisor is reaching into. Kept distinct from
  // ownsOrder so those cards can still say whose table they are, instead of
  // silently looking like the supervisor's own.
  const actingForAnother = (o: Order): boolean => isSupervisor && !ownedByMe(o)
  // Who to name on a locked card. Confirmed guest orders carry the whole
  // "Guest QR Order · confirmed by <waiter>" string — show just the waiter.
  const orderWaiter = (o: Order): string => {
    const raw = o.created_by_name?.trim() ?? ''
    return raw.match(/confirmed by (.+)$/)?.[1].trim() || raw || 'Another waiter'
  }
  // Pending Orders tab: all active orders, newest first, filtered by table-name search.
  const pendingQuery   = pendingSearch.trim().toLowerCase()
  const pendingList    = pendingOrders
    .filter(o => !pendingQuery || (o.table_name ?? 'Takeaway').toLowerCase().includes(pendingQuery))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  // ── Pay modal ──

  function PayModal({ orderId, onClose }: { orderId: string; onClose: () => void }) {
    const order   = pendingOrders.find(o => o.id === orderId)
    const items   = order ? (orderItemsMap[order.id] ?? []) : []
    // Discounts included — the figure collected here must be the one on the bill.
    const tot     = items.reduce((s, i) => s + lineNetAmount(i), 0)
    // What a comp would actually write off. Sirocco's hotel buffet is owed by
    // the hotel rather than the guest, so it is never part of what is comped —
    // for every other restaurant this is simply the whole total.
    const compHidden = hotelCreditLines(order?.restaurant_id ?? null, items.map(i => ({ name: i.dish_name })))
    const compValue = items.reduce((s, i, idx) => s + (compHidden[idx] ? 0 : lineNetAmount(i)), 0)
    const name    = order?.table_name ?? (order?.table_id ? (tables.find(t => t.id === order.table_id)?.name ?? 'Table') : 'Takeaway')
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
                <span className="text-gray-700">
                  {item.dish_name}{item.qty > 1 ? ` ×${item.qty}` : ''}
                  {item.discount_percent ? <span className="text-green-700 font-semibold"> −{item.discount_percent}%</span> : null}
                </span>
                <span className="font-medium text-gray-900">{fmtRWF(lineNetAmount(item))} RWF</span>
              </div>
            ))}
            <div className="border-t border-gray-200 pt-2">
              <div className="flex justify-between font-bold text-base">
                <span>Total</span><span className="text-green-700">{fmtRWF(tot)} RWF</span>
              </div>
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-2 block">Payment Method</label>
            <div className="grid grid-cols-2 gap-2">
              {PAY_METHODS.map(m => (
                <button key={m} type="button"
                  onClick={() => {
                    setPayMethod(m)
                    if (m !== 'Credit') { setArCustomerName(''); setArCustomerPhone('') }
                    if (m !== NO_CHARGE) setNoChargeReason('')
                  }}
                  className={`py-2.5 rounded-lg text-sm font-medium border transition-all ${
                    payMethod === m
                      ? m === 'Credit'
                        ? 'bg-amber-500 text-white border-amber-500'
                        : m === NO_CHARGE
                          ? 'bg-purple-600 text-white border-purple-600'
                          : 'bg-green-500 text-white border-green-500'
                      : 'bg-white text-gray-700 border-gray-300 hover:border-green-400'
                  }`}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Credit takes no money now, so the tab is only collectable if we know
              whose it is — the name is required. Amber throughout, to keep it
              visually distinct from the tenders that actually put cash in the till. */}
          {payMethod === 'Credit' && (
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1.5 block">
                Customer name <span className="text-red-500">*</span>
              </label>
              <input
                value={arCustomerName}
                onChange={e => setArCustomerName(e.target.value)}
                placeholder="Who is this tab for?"
                className={`w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-amber-300 ${
                  arCustomerName.trim() ? 'border-gray-300' : 'border-red-300'
                }`}
              />
              <label className="text-xs font-semibold text-gray-600 mb-1.5 mt-3 block">
                Phone <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <input
                value={arCustomerPhone}
                onChange={e => setArCustomerPhone(e.target.value)}
                inputMode="tel"
                placeholder="e.g. 0788123456"
                className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-amber-300"
              />
              <p className="mt-1 text-xs text-amber-700">
                No money is taken now — this is recorded as money owed, and collected later.
              </p>
            </div>
          )}

          {/* A comp is the one settlement with nothing to reconcile against, so
              the reason is the whole audit trail. Required, and it follows the
              order all the way to the manager's No Charge report. */}
          {payMethod === NO_CHARGE && (
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1.5 block">
                Reason <span className="text-red-500">*</span>
              </label>
              <input
                value={noChargeReason}
                onChange={e => setNoChargeReason(e.target.value)}
                placeholder="e.g. Owner's guests, staff meal, sent back"
                className={`w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-purple-300 ${
                  noChargeReason.trim() ? 'border-gray-300' : 'border-red-300'
                }`}
              />
              <p className="mt-1 text-xs text-purple-700">
                Nothing is charged. The food still comes off stock, and {fmtRWF(compValue)} RWF is recorded as comped.
              </p>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2.5 rounded-xl hover:bg-gray-50">
              Cancel
            </button>
            <button onClick={() => collectPayment(orderId)}
              disabled={
                payingSaving
                || (payMethod === 'Credit' && !arCustomerName.trim())
                || (payMethod === NO_CHARGE && !noChargeReason.trim())
              }
              className={`flex-1 disabled:opacity-60 text-white text-sm font-semibold py-2.5 rounded-xl ${
                payMethod === 'Credit'
                  ? 'bg-amber-500 hover:bg-amber-600'
                  : payMethod === NO_CHARGE
                    ? 'bg-purple-600 hover:bg-purple-700'
                    : 'bg-green-500 hover:bg-green-600'
              }`}>
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
            <RefreshCw className={`h-4 w-4 text-gray-500 ${isRefreshing ? 'animate-spin' : ''}`} />
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
              const orderMeta = [
                order.table_name ?? 'Takeaway',
                order.created_by_name?.trim() || null,
                new Date(order.created_at).toLocaleString('en-RW', {
                  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                }),
              ].filter(Boolean).join(' · ')

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
                        {!order.synced && (() => {
                          if (order.sync_error) return (
                            <span title={order.sync_error} className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                              <AlertCircle className="h-3 w-3" />
                              Sync error
                            </span>
                          )
                          if (!isOnline) return (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
                              <WifiOff className="h-3 w-3" />
                              Saved offline
                            </span>
                          )
                          return (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                              <Cloud className="h-3 w-3" />
                              Syncing...
                            </span>
                          )
                        })()}
                      </div>
                      <p className="text-xs text-gray-500 mt-1">{orderMeta}</p>
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
  // PENDING ORDERS MODE — every active order as a card, searchable by table
  // ─────────────────────────────────────────────────────────────────────────────

  if (mode === 'pending') {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-gray-800">Pending Orders</h2>
            <p className="text-sm text-gray-500">{pendingOrders.length} active</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text" value={pendingSearch}
              onChange={e => setPendingSearch(e.target.value)}
              placeholder="Search table…"
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-orange-400 w-40"
            />
            <button
              onClick={() => { setJoinMode(m => !m); setJoinIds([]); setJoinError(null) }}
              title="Combine several bills into one"
              className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors ${
                joinMode
                  ? 'border-orange-500 bg-orange-500 text-white'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}>
              {joinMode ? 'Cancel join' : 'Join orders'}
            </button>
            <button onClick={loadPOS} className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50" title="Refresh">
              <RefreshCw className={`h-4 w-4 text-gray-500 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {joinMode && (
          <div className="rounded-xl border border-orange-300 bg-orange-50 px-4 py-3 space-y-2">
            <p className="text-sm font-semibold text-orange-900">
              Pick the orders to combine{joinIds.length ? ` — ${joinIds.length} selected` : ''}
            </p>
            <p className="text-xs text-orange-800 leading-relaxed">
              They become one bill under the oldest order number. Nothing is
              re-priced, and nothing is sent to the kitchen again.
              {joinIds.length >= 2 && joinNeedsApproval(joinIds) && ' These belong to different waiters, so a supervisor PIN is needed.'}
            </p>
            {joinError && (
              <p className="text-xs font-semibold text-red-700">{joinError}</p>
            )}
            <button
              disabled={joinIds.length < 2}
              onClick={() => {
                setJoinError(null)
                if (joinNeedsApproval(joinIds)) setJoinAwaitingPin(true)
                else void performJoin()
              }}
              className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-xl transition-colors">
              {joinIds.length < 2 ? 'Select at least two orders' : `Join ${joinIds.length} orders`}
            </button>
          </div>
        )}

        {confirmSuccess && (
          <div className="rounded-xl border border-green-300 bg-green-50 px-3 py-2.5 text-sm font-semibold text-green-800 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-600" /> {confirmSuccess}
          </div>
        )}
        {submitError && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{submitError}</div>
        )}

        {loading ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : pendingList.length === 0 ? (
          <div className="bg-white rounded-xl border-2 border-dashed border-gray-200 p-12 text-center">
            <ShoppingBag className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">{pendingSearch ? 'No matching tables' : 'No pending orders'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {pendingList.map(ord => {
              const oi  = orderItemsMap[ord.id] ?? []
              // Discounts included, so the card, the bill and the payment all
              // quote the guest the same figure.
              const tot = oi.reduce((s, i) => s + lineNetAmount(i), 0)
              // Another waiter's order: shown in full, but read-only — the
              // action row is replaced by a lock line so nobody settles,
              // edits or cancels a table they are not serving.
              const mine = ownsOrder(ord)
              return (
                <div key={ord.id} className={`bg-white border rounded-xl overflow-hidden ${mine ? 'border-gray-200' : 'border-gray-200 opacity-60'}`}>
                  <div className="bg-gray-50 px-3 py-2 flex justify-between items-center border-b border-gray-100 gap-2">
                    {joinMode && (
                      <input
                        type="checkbox"
                        checked={joinIds.includes(ord.id)}
                        onChange={e => setJoinIds(ids => e.target.checked ? [...ids, ord.id] : ids.filter(i => i !== ord.id))}
                        className="h-4 w-4 flex-shrink-0 accent-orange-500"
                      />
                    )}
                    <span className="text-xs font-bold text-gray-700 truncate">{ord.order_number}</span>
                    <span className="text-xs text-gray-500 truncate ml-auto">{ord.table_name ?? 'Takeaway'}</span>
                  </div>
                  <div className="px-3 py-2 space-y-1.5">
                    {oi.map(item => (
                      <div key={item.id}>
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm text-gray-800 font-medium flex-1 min-w-0 leading-snug">
                            {item.dish_name}{item.qty > 1 ? ` ×${item.qty}` : ''}
                          </span>
                          {/* A discounted line shows both numbers: the guest can
                              see what came off, and so can whoever checks the
                              till at the end of the night. */}
                          <span className="text-sm font-semibold text-gray-900 flex-shrink-0 text-right">
                            {item.discount_percent ? (
                              <>
                                <span className="block text-[11px] font-normal text-gray-400 line-through leading-tight">
                                  {fmtRWF(item.dish_price * item.qty)}
                                </span>
                                <span className="block text-green-700 leading-tight">
                                  {fmtRWF(lineNetAmount(item))} RWF
                                </span>
                              </>
                            ) : (
                              <>{fmtRWF(item.dish_price * item.qty)} RWF</>
                            )}
                          </span>
                          {mine && !joinMode && (
                            <button
                              onClick={() => { setMoveTarget({ orderId: ord.id, item }); setMoveTableId('') }}
                              title={`Move ${item.dish_name} to another table`}
                              className="flex-shrink-0 rounded-lg border border-gray-200 px-2 py-0.5 text-[11px] font-bold text-gray-400 transition-colors hover:border-blue-300 hover:text-blue-600">
                              Move
                            </button>
                          )}
                          {mine && !joinMode && (
                            <button
                              onClick={() => { setDiscountTarget({ orderId: ord.id, item }); setDiscountPct(item.discount_percent ? String(item.discount_percent) : '') }}
                              title={item.discount_percent ? `${item.discount_percent}% off — tap to change` : 'Add a discount'}
                              className={`flex-shrink-0 rounded-lg border px-2 py-0.5 text-[11px] font-bold transition-colors ${
                                item.discount_percent
                                  ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100'
                                  : 'border-gray-200 text-gray-400 hover:border-orange-300 hover:text-orange-600'
                              }`}>
                              {item.discount_percent ? `-${item.discount_percent}%` : '[ … ]%'}
                            </button>
                          )}
                        </div>
                        {/* Modifiers ("no sauce", "extra pickles") — same style as the cart */}
                        {item.notes && (
                          <p className="text-xs text-orange-600 italic leading-snug">&gt; {item.notes}</p>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-gray-100 px-3 py-2 space-y-1.5">
                    <div className="flex justify-between text-sm font-bold text-gray-900"><span>Total</span><span className="text-green-700">{fmtRWF(tot)} RWF</span></div>
                    {/* Supervisor reaching into someone else's table. The card is
                        fully actionable, so the only thing that still needs
                        saying is whose table it is. */}
                    {actingForAnother(ord) && (
                      <p className="flex items-center justify-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg py-1 px-2">
                        <ShieldAlert className="h-3 w-3 flex-shrink-0" /> {orderWaiter(ord)}&apos;s table
                      </p>
                    )}
                    {!mine ? (
                      <p className="flex items-center justify-center gap-1 py-2 text-xs font-semibold text-gray-500">
                        <Lock className="h-3.5 w-3.5 flex-shrink-0" /> {`${orderWaiter(ord)}'s order`}
                      </p>
                    ) : ord.status === 'UNCONFIRMED' ? (
                      <button
                        onClick={() => {
                          setSubmitError(null)
                          // Waiter identity already established on the opening
                          // page — no need to ask for the code again.
                          if (waiterName) { void confirmIncomingOrder(ord.id, waiterName); return }
                          setIncomingConfirmId(ord.id); setShowCodeModal(true)
                        }}
                        className="w-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold py-2 rounded-xl flex items-center justify-center gap-1 transition-colors">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Confirm & send to kitchen
                      </button>
                    ) : (
                      <>
                        <div className="flex gap-1.5 pt-0.5">
                          {!ord.served_at && (
                            <button onClick={() => markOrderServed(ord.id)}
                              className="flex-1 flex items-center justify-center gap-1 border border-green-300 hover:bg-green-50 text-green-700 text-xs font-semibold py-2 rounded-xl transition-colors">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Served
                            </button>
                          )}
                          <button onClick={() => setPayingOrderId(ord.id)}
                            className="flex-1 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold py-2 rounded-xl flex items-center justify-center gap-1 transition-colors">
                            <CreditCard className="h-3.5 w-3.5" /> Pay
                          </button>
                        </div>
                        {ord.source === 'tablet' && (
                          ord.tickets_pushed_at ? (
                            <div className="w-full flex items-center justify-center gap-1 border border-green-200 bg-green-50 text-green-700 text-xs font-semibold py-2 rounded-xl">
                              <Printer className="h-3.5 w-3.5" /> Pushed to kitchen
                            </div>
                          ) : ownsOrder(ord) ? (
                            <button onClick={() => { void pushToKitchen(ord, oi) }}
                              className="w-full flex items-center justify-center gap-1 bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold py-2 rounded-xl transition-colors">
                              <Printer className="h-3.5 w-3.5" /> Push to kitchen
                            </button>
                          ) : (
                            // Someone else's table. Shown, not hidden, so this waiter
                            // can see the food has not gone in yet and tell them —
                            // but they cannot fire another waiter's order themselves.
                            <div className="w-full flex items-center justify-center gap-1 border border-gray-200 bg-gray-50 text-gray-400 text-xs font-semibold py-2 rounded-xl">
                              <Printer className="h-3.5 w-3.5" /> Push — {orderWaiter(ord)} only
                            </div>
                          )
                        )}
                        <button onClick={() => onEditOrder?.(ord.id)}
                          className="w-full flex items-center justify-center gap-1 border border-blue-300 hover:bg-blue-50 text-blue-700 text-xs font-semibold py-2 rounded-xl transition-colors">
                          <StickyNote className="h-3.5 w-3.5" /> Edit / Add items
                        </button>
                        <button onClick={() => printBill(ord, oi)}
                          className="w-full flex items-center justify-center gap-1 border border-gray-300 hover:bg-gray-50 text-gray-700 text-xs font-semibold py-2 rounded-xl transition-colors">
                          <Printer className="h-3.5 w-3.5" /> Print Bill
                        </button>
                        <button onClick={() => setCancelingOrderId(ord.id)}
                          className="w-full flex items-center justify-center gap-1 text-xs text-red-400 hover:text-red-600 py-1 transition-colors">
                          <ShieldAlert className="h-3 w-3" /> Cancel
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Discount: the percentage is typed first, then a supervisor approves
            it. Nothing is written until both are in, so an unapproved discount
            never reaches a bill. */}
        {discountTarget && !discountAwaitingPin && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
              <h3 className="font-bold text-gray-900">Discount this line</h3>
              <div className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3">
                <p className="text-sm font-semibold text-gray-900">{discountTarget.item.dish_name}</p>
                <p className="text-sm text-gray-600 mt-0.5">
                  {discountTarget.item.qty} × {fmtRWF(discountTarget.item.dish_price)} = {fmtRWF(discountTarget.item.dish_price * discountTarget.item.qty)} RWF
                </p>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-600 mb-1 block">Discount %</label>
                <input
                  autoFocus
                  type="text"
                  inputMode="decimal"
                  value={discountPct}
                  onChange={e => setDiscountPct(e.target.value.replace(/[^0-9.]/g, '').slice(0, 5))}
                  placeholder="e.g. 10"
                  className="w-full border border-gray-300 rounded-xl px-3 py-3 text-center text-2xl font-bold outline-none focus:ring-2 focus:ring-orange-400"
                />
                <p className="mt-1.5 text-xs text-gray-500">
                  {(() => {
                    const n = Number(discountPct)
                    if (!discountPct.trim()) return 'Leave empty to remove the discount.'
                    if (!Number.isFinite(n) || n <= 0 || n > 100) return 'Enter a number between 1 and 100.'
                    const net = discountTarget.item.dish_price * discountTarget.item.qty * (1 - n / 100)
                    return `Guest pays ${fmtRWF(net)} RWF`
                  })()}
                </p>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => { setDiscountTarget(null); setDiscountPct('') }}
                  className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-3 rounded-xl hover:bg-gray-50">
                  Go back
                </button>
                <button
                  onClick={() => setDiscountAwaitingPin(true)}
                  disabled={Boolean(discountPct.trim()) && !(Number(discountPct) > 0 && Number(discountPct) <= 100)}
                  className="flex-1 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-sm font-semibold py-3 rounded-xl transition-colors">
                  Get approval
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 1 — where is this line actually for? Every table is offered, not
            just the free ones: a line often belongs to a table that already has
            a bill open. */}
        {moveTarget && !moveAwaitingPin && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-gray-900">Move item to another table</h3>
                <button onClick={() => { setMoveTarget(null); setMoveTableId('') }}>
                  <X className="h-5 w-5 text-gray-400 hover:text-gray-600" />
                </button>
              </div>
              <div className="rounded-xl bg-gray-50 p-3">
                <p className="text-sm font-semibold text-gray-900">{moveTarget.item.dish_name}</p>
                <p className="text-xs text-gray-500">
                  {moveTarget.item.qty} × {fmtRWF(moveTarget.item.dish_price)} = {fmtRWF(lineNetAmount(moveTarget.item))} RWF
                </p>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-600">Move to</label>
                <select
                  value={moveTableId}
                  onChange={e => setMoveTableId(e.target.value)}
                  className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-300">
                  <option value="">Choose a table…</option>
                  {tables.map(t => {
                    const busy = pendingOrders.some(o => o.table_id === t.id)
                    return (
                      <option key={t.id} value={t.id}>
                        {t.name}{busy ? ' — has an open bill' : ''}
                      </option>
                    )
                  })}
                </select>
                <p className="mt-1.5 text-xs text-gray-500">
                  It leaves this bill and opens its own pending bill at that table. Nothing is charged twice.
                </p>
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => { setMoveTarget(null); setMoveTableId('') }}
                  className="flex-1 rounded-xl border border-gray-300 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={() => setMoveAwaitingPin(true)} disabled={!moveTableId}
                  className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
                  Continue
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 2 — the same PIN that approves a cancellation. */}
        {moveTarget && moveAwaitingPin && (
          <SupervisorPinDialog
            title="Approve move"
            prompt={`Move ${moveTarget.item.dish_name} to ${tables.find(t => t.id === moveTableId)?.name ?? 'another table'}. Enter the supervisor PIN to approve.`}
            confirmLabel="Approve"
            busyLabel="Moving…"
            onClose={() => setMoveAwaitingPin(false)}
            onApproved={applyApprovedMove}
          />
        )}

        {discountTarget && discountAwaitingPin && (
          <SupervisorPinDialog
            title="Approve discount"
            prompt={
              discountPct.trim()
                ? `${Number(discountPct)}% off ${discountTarget.item.dish_name}. Enter the supervisor PIN to approve.`
                : `Remove the discount on ${discountTarget.item.dish_name}. Enter the supervisor PIN to approve.`
            }
            confirmLabel="Approve"
            busyLabel="Approving…"
            onClose={() => setDiscountAwaitingPin(false)}
            onApproved={applyApprovedDiscount}
          />
        )}

        {/* Joining another waiter's table into yours moves who gets credited
            for the sale, so it takes the same approval a cancellation does. */}
        {joinAwaitingPin && (
          <SupervisorPinDialog
            title="Approve join"
            prompt={`These ${joinIds.length} orders belong to different waiters. Enter the supervisor PIN to combine them.`}
            confirmLabel="Approve"
            busyLabel="Joining…"
            onClose={() => setJoinAwaitingPin(false)}
            onApproved={(approvedBy) => performJoin(approvedBy)}
          />
        )}

        {payingOrderId && (
          <PayModal orderId={payingOrderId} onClose={() => { setPayingOrderId(null); setPayMethod('Cash'); setArCustomerName(''); setArCustomerPhone('') }} />
        )}
        {cancelingOrderId && (
          <CancelModal
            order={pendingOrders.find(o => o.id === cancelingOrderId)}
            onClose={() => setCancelingOrderId(null)}
            onCanceled={handleOrderCanceled}
          />
        )}
        {showCodeModal && (
          <OrderCodeModal
            onClose={() => { setShowCodeModal(false); setIncomingConfirmId(null) }}
            onConfirmed={(name) => {
              setShowCodeModal(false)
              if (incomingConfirmId) {
                const id = incomingConfirmId
                setIncomingConfirmId(null)
                void confirmIncomingOrder(id, name)
              }
            }}
          />
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

          {/* Row 1: time label + search */}
          <div className="flex items-center justify-between py-2">
            <h2 className="text-xl font-bold text-gray-900">{getTimeLabel()}</h2>
            {activeTableKeys.size > 0 && (
              <span className="text-[13px] font-semibold text-orange-500">
                {activeTableKeys.size} pending
              </span>
            )}
            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Mobile: jump to order panel */}
              {cartItems.length > 0 && (
                <button
                  onClick={() => setShowPanel('order')}
                  className="md:hidden flex items-center gap-1 bg-orange-500 text-white px-2.5 py-1 rounded-full text-xs font-bold">
                  <ShoppingBag className="h-3.5 w-3.5" />
                  <span>{cartItems.length}</span>
                </button>
              )}
              <input
                type="text" value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search dishes…"
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-orange-400 w-44"
              />
              <button onClick={() => { loadPOS(); setShowPanel('dishes') }}
                className="p-2 rounded-lg hover:bg-gray-100 transition-colors" title="Refresh">
                <RefreshCw className={`h-4 w-4 text-gray-500 ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Category strip */}
        <div className="flex-shrink-0 px-4 py-2 flex items-center gap-2 overflow-x-auto" style={{scrollbarWidth:'none'}}>
          <button
            onClick={() => setSelectedCategory(null)}
            className={`flex-shrink-0 rounded-lg px-4 py-2 text-left transition-all ${
              selectedCategory === null
                ? 'bg-gray-800 text-white shadow'
                : 'bg-white text-gray-700 border border-gray-200 hover:border-gray-300'
            }`}>
            <span className="block text-sm font-bold">All items</span>
            <span className="text-xs opacity-70">{dishes.length} items</span>
          </button>
          {categories.map((cat, idx) => {
            const [bg, fg] = COLOR_POOL[idx % COLOR_POOL.length]
            const count    = dishes.filter(d => d.category === cat).length
            const isActive = selectedCategory === cat
            return (
              <button key={cat} onClick={() => setSelectedCategory(isActive ? null : cat)}
                className={`flex-shrink-0 rounded-lg px-4 py-2 text-left transition-all ${bg} ${fg} ${
                  isActive ? 'ring-2 ring-gray-900 ring-offset-1' : 'hover:shadow-md'
                }`}>
                <span className="block text-sm font-bold">{cat}</span>
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
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 gap-3">
              {filteredDishes.map(dish => {
                const qtyInCart = cartItems.filter(i => i.dishId === dish.id).reduce((s, i) => s + i.qty, 0)
                const catIdx    = categories.indexOf(dish.category ?? '')
                const [bgTop,, bgBottom] = catIdx >= 0
                  ? COLOR_POOL[catIdx % COLOR_POOL.length]
                  : ['bg-slate-400', 'text-white', 'bg-slate-700']
                const initials = dish.name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
                return (
                  <button key={dish.id} onClick={() => addDishToOrder(dish)}
                    className="relative rounded-xl overflow-hidden hover:shadow-md hover:scale-[1.02] active:scale-[0.97] transition-all text-left flex flex-col h-full">
                    <div className={`${bgTop} h-[78px] w-full flex items-center justify-center`}>
                      <span className="text-white font-black text-3xl tracking-tight select-none drop-shadow">{initials}</span>
                    </div>
                    <div className={`${bgBottom} px-3 py-2 flex-1 w-full`}>
                      <p className="text-white text-[13px] font-semibold leading-tight line-clamp-3">{dish.name}</p>
                      <p className="text-white/70 font-medium text-[13px] mt-0.5">
                        {fmtRWF(dish.selling_price)} RWF
                      </p>
                    </div>
                    {qtyInCart > 0 && (
                      <span className="absolute top-1.5 right-1.5 h-7 min-w-[28px] bg-gray-900 border-2 border-white text-white text-xs font-bold rounded-full flex items-center justify-center px-1 shadow-sm">
                        {qtyInCart}
                      </span>
                    )}
                    {outDishIds.has(dish.id) && (
                      <span className="absolute top-1.5 left-1.5 bg-red-600 text-white text-[10px] font-bold rounded px-1.5 py-0.5 shadow-sm select-none">
                        Out
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
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
          <span className="text-2xl font-black text-gray-900">{tableNumber}</span>
          <div className="relative" ref={tablePickerRef}>
            <button
              type="button"
              onClick={() => {
                setTablePickerOpen(o => !o)
                setTablePickerQuery('')
                requestAnimationFrame(() => tablePickerInputRef.current?.focus())
              }}
              className="flex items-center gap-1.5 text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-orange-400 bg-white text-gray-600 hover:bg-gray-50"
            >
              {tableNumber}
              <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
            </button>
            {tablePickerOpen && (
              <div className="absolute right-0 top-full mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-20 overflow-hidden">
                <div className="flex items-center gap-1.5 border-b border-gray-100 px-2.5 py-2">
                  <Search className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                  <input
                    ref={tablePickerInputRef}
                    type="text"
                    value={tablePickerQuery}
                    onChange={e => setTablePickerQuery(e.target.value)}
                    placeholder="Search table…"
                    className="flex-1 text-sm outline-none text-gray-700 placeholder:text-gray-400"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto py-1">
                  {(() => {
                    const q = tablePickerQuery.trim().toLowerCase()
                    const rows: Array<{ key: string; label: string }> = [
                      { key: 'takeaway', label: 'Takeaway' },
                      ...tables.map(t => ({ key: t.id, label: t.name })),
                    ].filter(row => !q || row.label.toLowerCase().includes(q))

                    if (rows.length === 0) {
                      return <div className="px-3 py-4 text-center text-sm text-gray-400">No tables found</div>
                    }

                    return rows.map(row => (
                      <button
                        key={row.key}
                        type="button"
                        onClick={() => { setSelectedTableKey(row.key); setTablePickerOpen(false); setTablePickerQuery('') }}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-orange-50 ${
                          row.key === selectedTableKey ? 'bg-orange-50 text-orange-600 font-semibold' : 'text-gray-700'
                        }`}
                      >
                        {row.label}
                      </button>
                    ))
                  })()}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Mode label strip / editing banner */}
        {editingOrder ? (
          <div className="flex-shrink-0 px-4 py-1.5 bg-blue-50 border-b border-blue-100 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-blue-700">
              Editing {editingOrder.order_number} — new items only
            </span>
            <button onClick={cancelEditOrder} title="Stop editing" className="p-0.5 rounded hover:bg-blue-100">
              <X className="h-3.5 w-3.5 text-blue-500" />
            </button>
          </div>
        ) : (
          <div className={`flex-shrink-0 px-4 py-1 text-[11px] font-semibold uppercase tracking-widest ${
            isBuilding ? 'bg-orange-50 text-orange-600' : 'bg-gray-50 text-gray-400'
          }`}>
            {isBuilding ? 'Building order — not sent yet' : 'No items'}
          </div>
        )}

        {/* Items list — cart only (confirmed orders live in the Pending Orders tab) */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {/* Already-sent items of the order being edited — locked, no re-tickets */}
          {editingOrder && editingItems.length > 0 && (
            <div className="mb-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Already sent to kitchen</p>
              {editingItems.map(item => (
                <div key={item.id} className="flex items-start justify-between">
                  <span className="text-xs text-gray-500 leading-snug flex-1 min-w-0">
                    {item.dish_name}{item.qty > 1 ? ` ×${item.qty}` : ''}
                    {item.notes ? <span className="italic text-orange-400"> &gt; {item.notes}</span> : null}
                  </span>
                  <span className="text-xs text-gray-500 ml-3 flex-shrink-0">{fmtRWF(item.dish_price * item.qty)}</span>
                </div>
              ))}
            </div>
          )}
          {cartItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-12 text-gray-400">
              <ShoppingBag className="h-8 w-8 mb-3 text-gray-300" />
              <p className="text-sm">No items yet</p>
              <p className="text-xs mt-1">Tap a dish to add it</p>
              {confirmSuccess && (
                <div className="mt-4 rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-xs font-semibold text-green-800 flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-green-600" /> {confirmSuccess}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2.5">
              {cartItems.map(item => (
                <div key={item.dishId}>
                  <button onClick={() => setActiveItemId(item.dishId)}
                    className="w-full flex items-start justify-between text-left rounded-lg px-1 py-1 hover:bg-gray-50 transition-colors">
                    <span className="text-sm text-gray-800 font-medium leading-snug flex-1 min-w-0">
                      {item.dishName}{item.qty > 1 ? ` ×${item.qty}` : ''}
                    </span>
                    <span className="text-sm font-semibold text-gray-900 ml-3 flex-shrink-0">
                      {fmtRWF(item.dishPrice * item.qty)} RWF
                    </span>
                  </button>
                  {noteEditId === item.dishId ? (
                    <input
                      autoFocus
                      value={item.note ?? ''}
                      onChange={e => setCartItemNote(item.dishId, e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') setNoteEditId(null) }}
                      onBlur={() => setNoteEditId(null)}
                      placeholder="Modifiers — e.g. extra pickles"
                      className="ml-2 mt-1 w-[calc(100%-0.5rem)] border border-orange-200 rounded-lg px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  ) : item.note ? (
                    <p className="ml-2 mt-0.5 text-xs text-orange-600 italic leading-snug">&gt; {item.note}</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Totals + confirm — only while building a cart */}
        {isBuilding && (
          <div className="flex-shrink-0 border-t border-gray-200 px-4 py-2 space-y-1.5">
            {submitError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700">
                {submitError}
              </div>
            )}
            {/* Covers — optional. Blank is fine; it just leaves this table out
                of the manager's average spend per guest. */}
            {!editingOrder && (
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="guest-count" className="text-xs font-medium text-gray-500">
                  Guests at table <span className="text-gray-400">(optional)</span>
                </label>
                <input
                  id="guest-count"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={guestsByTable[selectedTableKey] ?? ''}
                  onChange={e => {
                    const next = e.target.value
                    setGuestsByTable(prev => ({ ...prev, [selectedTableKey]: next }))
                  }}
                  placeholder="—"
                  className="w-20 border border-gray-200 rounded-lg px-2 py-1 text-sm text-center outline-none focus:ring-2 focus:ring-orange-400"
                />
              </div>
            )}
            <div className="flex justify-between text-base font-bold text-gray-900">
              <span>{editingOrder ? 'New items' : 'Total'}</span><span>{fmtRWF(totalAmount)} RWF</span>
            </div>
            {/* The hotel settles its buffet as a receivable, so it is not
                collected here — show the waiter what the guest actually pays. */}
            {cartCreditAmount > 0 && (
              <>
                <div className="flex justify-between text-xs font-semibold text-gray-500">
                  <span>On hotel credit</span><span>{fmtRWF(cartCreditAmount)} RWF</span>
                </div>
                <div className="flex justify-between text-sm font-bold text-green-700">
                  <span>Due at table</span><span>{fmtRWF(cartDueAtTable)} RWF</span>
                </div>
              </>
            )}
            {editingOrder && (
              <div className="flex justify-between text-xs font-semibold text-gray-500">
                <span>Order total after update</span>
                <span>{fmtRWF(editingItems.reduce((s, i) => s + i.dish_price * i.qty, 0) + totalAmount)} RWF</span>
              </div>
            )}
            <button
              onClick={() => {
                setSubmitError(null)
                if (editingOrder) { void appendToOrder(); return }
                // Waiter identity already established on the opening page.
                if (waiterName) { void confirmOrder(waiterName); return }
                setShowCodeModal(true)
              }}
              disabled={confirmingOrder}
              className={`w-full disabled:cursor-not-allowed disabled:opacity-60 text-white font-semibold py-3 rounded-2xl text-base transition-colors shadow-sm ${
                editingOrder ? 'bg-blue-600 hover:bg-blue-700' : 'bg-orange-500 hover:bg-orange-600'
              }`}>
              {confirmingOrder ? (editingOrder ? 'Updating…' : 'Confirming…') : (editingOrder ? 'Add to Order' : 'Confirm Order')}
            </button>
            <button
              onClick={() => {
                setLocalCart(prev => ({ ...prev, [selectedTableKey]: [] }))
                setGuestsByTable(prev => ({ ...prev, [selectedTableKey]: '' }))
                setSubmitError(null)
              }}
              disabled={confirmingOrder}
              className="w-full text-xs text-gray-400 hover:text-red-500 py-0.5 transition-colors">
              Clear cart
            </button>
          </div>
        )}
      </div>

      {payingOrderId && (
        <PayModal
          orderId={payingOrderId}
          onClose={() => { setPayingOrderId(null); setPayMethod('Cash'); setArCustomerName(''); setArCustomerPhone('') }}
        />
      )}

      {cancelingOrderId && (
        <CancelModal
          order={pendingOrders.find(o => o.id === cancelingOrderId)}
          onClose={() => setCancelingOrderId(null)}
          onCanceled={handleOrderCanceled}
        />
      )}

      {showCodeModal && (
        <OrderCodeModal
          onClose={() => { setShowCodeModal(false); setIncomingConfirmId(null) }}
          onConfirmed={(name) => {
            setShowCodeModal(false)
            if (incomingConfirmId) {
              const id = incomingConfirmId
              setIncomingConfirmId(null)
              void confirmIncomingOrder(id, name)
            } else {
              void confirmOrder(name)
            }
          }}
        />
      )}

      {/* Item actions popup — tap a cart item to add modifiers (a note) or delete it */}
      {activeItemId && (() => {
        const it = cartItems.find(i => i.dishId === activeItemId)
        if (!it) return null
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setActiveItemId(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-4 space-y-3" onClick={e => e.stopPropagation()}>
              <p className="text-sm font-bold text-gray-900 text-center leading-snug">
                {it.dishName}{it.qty > 1 ? ` ×${it.qty}` : ''}
              </p>
              <button onClick={() => { setNoteEditId(activeItemId); setActiveItemId(null) }}
                className="w-full flex items-center justify-center gap-2 border border-orange-300 text-orange-700 font-semibold py-3 rounded-xl hover:bg-orange-50 transition-colors">
                <StickyNote className="h-4 w-4" /> Modifiers
              </button>
              <button onClick={() => { removeLocalCartItem(activeItemId); setActiveItemId(null) }}
                className="w-full flex items-center justify-center gap-2 border border-red-300 text-red-600 font-semibold py-3 rounded-xl hover:bg-red-50 transition-colors">
                <Trash2 className="h-4 w-4" /> Delete item
              </button>
              <button onClick={() => setActiveItemId(null)}
                className="w-full text-xs text-gray-400 hover:text-gray-600 py-1">Cancel</button>
            </div>
          </div>
        )
      })()}

    </div>
  )
}

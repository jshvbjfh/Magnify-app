'use client'
import { useState, useEffect, useCallback } from 'react'
import { Search, X, ShoppingBag, CheckCircle2, Sparkles, Receipt, CreditCard, RefreshCw, ArrowLeftRight, UtensilsCrossed, ArrowLeft, Printer } from 'lucide-react'

type Dish        = { id: string; name: string; sellingPrice: number; category: string | null; isActive: boolean }
type Sale        = { id: string; dish: { name: string }; quantitySold: number; totalSaleAmount: number; calculatedFoodCost: number; paymentMethod: string; saleDate: string }
type Table       = { id: string; name: string; seats: number; status: string }
type PendingItem = { id: string; tableId: string | null; tableName: string; dishId: string; dishName: string; dishPrice: number; qty: number; status?: string; waiter?: { name: string } }

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
  // Mobile: which panel is visible ('dishes' | 'order')
  const [showPanel, setShowPanel] = useState<'dishes' | 'order'>('dishes')
  // Payment state
  const [payingTableKey, setPayingTableKey] = useState<string | null>(null)
  const [payMethod,      setPayMethod]      = useState('Cash')
  const [payingSaving,   setPayingSaving]   = useState(false)
  // When true: show empty build-mode panel even if confirmed orders exist
  const [addingNew, setAddingNew] = useState(false)

  const loadTables = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/tables-db', { credentials: 'include' })
      const data = await res.json()
      setTables(Array.isArray(data) ? data : [])
    } catch {}
  }, [])

  const loadPending = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/pending', { credentials: 'include' })
      const data = await res.json()
      setPending(Array.isArray(data) ? data : [])
    } catch {}
  }, [])

  const loadSales = useCallback(async () => {
    setLoading(true)
    try {
      const [d, s] = await Promise.all([
        fetch('/api/restaurant/dishes').then(r=>r.json()),
        fetch('/api/restaurant/dish-sales').then(r=>r.json()),
      ])
      setDishes((Array.isArray(d)?d:[]).filter((x:Dish)=>x.isActive))
      setSales(Array.isArray(s)?s:[])
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    loadTables(); loadPending(); loadSales()
    fetch('/api/restaurant/setup', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setBillHeader(data.restaurant?.billHeader ?? ''))
      .catch(() => {})
    // Poll pending + tables every 5 s so the ready banner and table status stay live
    const t = setInterval(() => { loadPending(); loadTables() }, 5000)
    return () => clearInterval(t)
  }, [loadTables, loadPending, loadSales])

  // Notify parent of pending count
  const byTable    = pending.reduce<Record<string, PendingItem[]>>((a, i) => { const k = i.tableId ?? 'takeaway'; (a[k] ??= []).push(i); return a }, {})
  const activeKeys = Object.keys(byTable)
  useEffect(() => { onPendingCountChange?.(activeKeys.length) }, [activeKeys.length, onPendingCountChange])

  const todayPaid = sales.filter(s => new Date(s.saleDate).toDateString() === new Date().toDateString()).reduce((s, x) => s + x.totalSaleAmount, 0)

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

  function removeLocalCartItem(dishId: string) {
    setLocalCart(prev => {
      const updated = (prev[selectedTableKey] ?? []).filter(i => i.dishId !== dishId)
      return { ...prev, [selectedTableKey]: updated }
    })
  }

  async function confirmOrder() {
    const cart = localCart[selectedTableKey] ?? []
    if (!cart.length) return
    const tableName = selectedTableKey === 'takeaway'
      ? 'Takeaway'
      : (tables.find(t => t.id === selectedTableKey)?.name ?? 'Table')
    await Promise.all(cart.map(item =>
      fetch('/api/restaurant/pending', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          tableId:   selectedTableKey === 'takeaway' ? 'takeaway' : selectedTableKey,
          tableName, dishId: item.dishId, dishName: item.dishName, dishPrice: item.dishPrice, qty: item.qty,
        })
      })
    ))
    setLocalCart(prev => ({ ...prev, [selectedTableKey]: [] }))
    setAddingNew(false)
    setSelectedTableKey('takeaway')
    setShowPanel('dishes')
    await loadPending(); await loadTables()
    window.dispatchEvent(new CustomEvent('refreshTables'))
  }

  function printBill(tableKey: string) {
    const items    = pending.filter(p => (p.tableId ?? 'takeaway') === tableKey)
    if (!items.length) return
    const tName    = tableKey === 'takeaway' ? 'Takeaway' : (tables.find(t => t.id === tableKey)?.name ?? 'Table')
    const sub      = items.reduce((s, i) => s + i.dishPrice * i.qty, 0)
    const vat      = Math.round(sub * VAT_RATE)
    const tot      = sub + vat
    const now      = new Date().toLocaleString('en-RW', { dateStyle: 'medium', timeStyle: 'short' })
    const headerLines = billHeader.trim()
      ? billHeader.trim().split('\n').map(l => `<p class="center">${l}</p>`).join('')
      : '<p class="center" style="font-size:15px;font-weight:bold">RECEIPT</p>'
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
  <tr><td>Subtotal</td><td>${sub.toLocaleString()} RWF</td></tr>
  <tr><td>VAT (18%)</td><td>${vat.toLocaleString()} RWF</td></tr>
  <tr class="total-row"><td>TOTAL</td><td>${tot.toLocaleString()} RWF</td></tr>
</table>
<div class="divider"></div>
<p class="footer">Thank you for dining with us!</p>
</body></html>`
    const win = window.open('', '_blank', 'width=350,height=600')
    if (!win) return
    win.document.write(html)
    win.document.close()
    win.focus()
    win.print()
  }

  async function voidOrder(tableKey: string) {
    setLocalCart(prev => ({ ...prev, [tableKey]: [] }))
    await fetch('/api/restaurant/pending', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ tableKey, clearTable: true })
    })
    setSelectedTableKey('takeaway')
    setShowPanel('dishes')
    await loadPending(); await loadTables()
    window.dispatchEvent(new CustomEvent('refreshTables'))
  }

  async function removePendingItem(id: string) {
    setPending(prev => prev.filter(p => p.id !== id))
    await fetch('/api/restaurant/pending', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ orderId: id })
    })
  }

  async function collectPayment(key: string) {
    const items = pending.filter(p => (p.tableId ?? 'takeaway') === key)
    if (!items.length) return
    setPayingSaving(true)
    try {
      await Promise.all(items.map(item =>
        fetch('/api/restaurant/dish-sales', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ dishId: item.dishId, quantitySold: item.qty, paymentMethod: payMethod })
        })
      ))
      await fetch('/api/restaurant/pending', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ tableKey: key, clearTable: true })
      })
      await Promise.all([loadPending(), loadSales(), loadTables()])
      window.dispatchEvent(new CustomEvent('refreshTables'))
      setPayingTableKey(null); setPayMethod('Cash')
    } catch (e) { console.error(e) }
    setPayingSaving(false)
  }

  const categories     = Array.from(new Set(dishes.map(d => d.category).filter(Boolean))) as string[]
  const filteredDishes = dishes.filter(d => {
    if (selectedCategory && d.category !== selectedCategory) return false
    if (searchQuery) return d.name.toLowerCase().includes(searchQuery.toLowerCase())
    return true
  })
  const cartItems      = localCart[selectedTableKey] ?? []
  const confirmedItems = pending.filter(p => (p.tableId ?? 'takeaway') === selectedTableKey)
  // While building OR user hit "New order": show cart (empty or filling). Otherwise show pending.
  const isBuilding     = cartItems.length > 0 || addingNew
  // Reset addingNew whenever the user switches table
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setAddingNew(false) }, [selectedTableKey])
  const rightItems     = isBuilding ? cartItems : confirmedItems
  const subtotal       = rightItems.reduce((s, i) => s + i.dishPrice * i.qty, 0)
  const vatAmt         = subtotal * VAT_RATE
  const total          = subtotal + vatAmt
  const tableNumber    = selectedTableKey === 'takeaway'
    ? 'T/A'
    : `#${tables.findIndex(t => t.id === selectedTableKey) + 1}`
  const tableLabel     = selectedTableKey === 'takeaway'
    ? 'Takeaway'
    : (tables.find(t => t.id === selectedTableKey)?.name ?? 'Table')

  // ── Shared payment modal ──────────────────────────────────────────────────────
  function PayModal({ tableKey, onClose }: { tableKey: string; onClose: () => void }) {
    const items = pending.filter(p => (p.tableId ?? 'takeaway') === tableKey)
    const sub   = items.reduce((s, i) => s + i.dishPrice * i.qty, 0)
    const vat   = sub * VAT_RATE
    const tot   = sub + vat
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
              const sub   = items.reduce((s, i) => s + i.dishPrice * i.qty, 0)
              const tot   = sub * (1 + VAT_RATE)
              return (
                <div key={key} className="bg-white rounded-2xl border-2 border-amber-200 shadow-sm overflow-hidden">
                  <div className="bg-amber-50 px-4 py-3 flex items-center justify-between border-b border-amber-200">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                      <span className="font-bold text-gray-900 text-sm">{items[0].tableName}</span>
                      <span className="text-xs text-amber-600 font-semibold bg-amber-100 px-1.5 py-0.5 rounded-full">Pending</span>
                    </div>
                    <span className="text-xs text-gray-400">{items.length} item{items.length > 1 ? 's' : ''}</span>
                  </div>
                  <div className="px-4 py-3 space-y-2">
                    {items.map(item => (
                      <div key={item.id} className="flex items-center justify-between group">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <button onClick={() => removePendingItem(item.id)}
                            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-50 transition-opacity flex-shrink-0">
                            <X className="h-3 w-3 text-red-400" />
                          </button>
                          <span className="text-xs text-gray-700 truncate">{item.dishName}</span>
                          {item.qty > 1 && <span className="text-xs text-gray-400 flex-shrink-0">×{item.qty}</span>}
                        </div>
                        <span className="text-xs font-semibold text-gray-900 flex-shrink-0 ml-2">{fmtRWF(item.dishPrice * item.qty)} RWF</span>
                      </div>
                    ))}
                  </div>
                  <div className="px-4 pb-4 pt-2 border-t border-gray-100 space-y-1">
                    <div className="flex justify-between text-xs text-gray-500"><span>Subtotal</span><span>{fmtRWF(sub)} RWF</span></div>
                    <div className="flex justify-between text-xs text-orange-600"><span>VAT (18%)</span><span>+{fmtRWF(sub * VAT_RATE)} RWF</span></div>
                    <div className="flex justify-between text-sm font-bold text-gray-900 border-t border-gray-100 pt-1.5"><span>Total</span><span>{fmtRWF(tot)} RWF</span></div>
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
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>{['Date', 'Dish', 'Qty', 'Revenue', 'Food Cost', 'Margin', 'Payment'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {sales.map(s => {
                  const mgn = s.totalSaleAmount > 0 ? ((s.totalSaleAmount - s.calculatedFoodCost) / s.totalSaleAmount * 100) : 0
                  return (
                    <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-gray-500 text-xs">{new Date(s.saleDate).toLocaleString('en-RW', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">{s.dish.name}</td>
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
                const tTotal     = tItems.reduce((s, i) => s + i.dishPrice * i.qty, 0) * (1 + VAT_RATE)
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
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
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
                    <div className={`${bgTop} h-[76px] w-full flex items-center justify-center`}>
                      <span className="text-white font-black text-2xl tracking-tight select-none drop-shadow">{initials}</span>
                    </div>
                    <div className={`${bgBottom} px-2.5 py-2.5 flex-1 w-full`}>
                      <p className="text-white text-[13px] font-semibold leading-tight line-clamp-2">{dish.name}</p>
                      <p className="text-white/70 font-medium text-[11px] mt-1">{fmtRWF(dish.sellingPrice)} RWF</p>
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

        {/* ── Check tab ── */}
        {orderTab === 'check' && (
          <>
            {/* Mode label */}
            <div className={`flex-shrink-0 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-widest ${
              isBuilding ? 'bg-orange-50 text-orange-600' : confirmedItems.length > 0 ? 'bg-amber-50 text-amber-700' : 'bg-gray-50 text-gray-400'
            }`}>
              {isBuilding ? 'Building order — not sent yet' : confirmedItems.length > 0 ? 'Pending Orders' : 'No items'}
            </div>

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
                              <X className="h-3 w-3 text-red-400" />
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
                            <button onClick={() => removePendingItem(item.id)}
                              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-50 transition-opacity flex-shrink-0">
                              <X className="h-3 w-3 text-red-400" />
                            </button>
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
                <div className="flex justify-between text-sm text-gray-600"><span>Subtotal</span><span>{fmtRWF(subtotal)} RWF</span></div>
                <div className="flex justify-between text-sm text-gray-600"><span>Tax (18%)</span><span>{fmtRWF(vatAmt)} RWF</span></div>
                <div className="flex justify-between text-base font-bold text-gray-900 border-t border-gray-100 pt-2">
                  <span>Total</span><span>{fmtRWF(total)} RWF</span>
                </div>
                {isBuilding ? (
                  <>
                    <button onClick={confirmOrder}
                      className="w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-4 rounded-2xl text-base transition-colors mt-1 shadow-sm">
                      Confirm Order
                    </button>
                    <button onClick={() => { setLocalCart(prev => ({ ...prev, [selectedTableKey]: [] })); setAddingNew(false) }}
                      className="w-full text-xs text-gray-400 hover:text-red-500 py-1 transition-colors">
                      Clear cart
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => printBill(selectedTableKey)}
                      className="w-full flex items-center justify-center gap-2 bg-gray-900 hover:bg-gray-700 text-white font-semibold py-4 rounded-2xl text-base transition-colors mt-1 shadow-sm">
                      <Printer className="h-5 w-5" /> Print Bill
                    </button>
                    <button onClick={() => setPayingTableKey(selectedTableKey)}
                      className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-2xl text-base transition-colors shadow-sm">
                      Confirm Payment
                    </button>
                    <button onClick={() => setAddingNew(true)}
                      className="w-full bg-orange-50 hover:bg-orange-100 text-orange-600 font-semibold py-3 rounded-2xl text-sm transition-colors border border-orange-200">
                      ＋ New order for this table
                    </button>
                    <button onClick={() => voidOrder(selectedTableKey)}
                      className="w-full text-xs text-red-400 hover:text-red-600 py-1 transition-colors">
                      Delete all orders
                    </button>
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
                <Sparkles className="h-4 w-4" /> Ask Jesse (AI)
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

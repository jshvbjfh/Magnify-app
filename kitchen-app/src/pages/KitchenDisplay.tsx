import { useState, useEffect, useRef, useCallback } from 'react'
import { LogOut, RefreshCw, Loader2, ChefHat, Clock, CheckCircle2, Utensils } from 'lucide-react'
import type { KitchenUser } from '../services/auth'
import { getToken } from '../services/auth'
import { apiRequest, parseResponse } from '../services/http'

interface KitchenItem {
  id: string
  orderId: string
  orderNumber: string
  tableName: string
  dishName: string
  qty: number
  notes: string | null
  kitchenStatus: 'new' | 'in_kitchen' | 'ready'
  addedAt: string
  waiterName: string | null
}

interface PendingResponse {
  restaurantName: string
  branchName: string
  branchType: string
  items: KitchenItem[]
}

const POLL_MS = 4_000
const SEEN_IDS_KEY = 'kitchen_seen_item_ids'
const MAX_SEEN = 2_000

function getSeenIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_IDS_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function saveSeenIds(ids: string[]) {
  const seen = getSeenIds()
  for (const id of ids) seen.add(id)
  const arr = Array.from(seen)
  if (arr.length > MAX_SEEN) arr.splice(0, arr.length - MAX_SEEN)
  localStorage.setItem(SEEN_IDS_KEY, JSON.stringify(arr))
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  const day = String(d.getDate()).padStart(2, '0')
  const mon = String(d.getMonth() + 1).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${day}/${mon}/${d.getFullYear()} ${hh}:${mm}`
}

interface Props {
  user: KitchenUser
  onLogout: () => void
}

export default function KitchenDisplay({ user, onLogout }: Props) {
  const [items, setItems] = useState<KitchenItem[]>([])
  const [restaurantName, setRestaurantName] = useState('')
  const [branchName, setBranchName] = useState('')
  const [branchType, setBranchType] = useState('kitchen')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [updating, setUpdating] = useState<Set<string>>(new Set())
  const printFrameRef = useRef<HTMLIFrameElement | null>(null)

  const printTickets = useCallback((
    newItems: KitchenItem[],
    rName: string,
    bName: string,
    bType: string,
  ) => {
    const byOrder = new Map<string, KitchenItem[]>()
    for (const item of newItems) {
      const list = byOrder.get(item.orderId) ?? []
      list.push(item)
      byOrder.set(item.orderId, list)
    }

    for (const [, orderItems] of byOrder) {
      const first = orderItems[0]
      const label = bType === 'bar' ? `BAR – ${bName}` : `KITCHEN – ${bName}`
      const dt = fmtDate(first.addedAt)

      const itemRows = orderItems.map(i => {
        const noteHtml = i.notes
          ? `<div class="note">&gt; ${escHtml(i.notes)}</div>`
          : ''
        return `<div class="item"><span class="qty">${i.qty}x</span><span class="dish">${escHtml(i.dishName)}</span></div>${noteHtml}`
      }).join('')

      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:monospace;font-size:12px;width:80mm;padding:4mm}
.center{text-align:center;margin-bottom:4px}
.title{font-size:14px;font-weight:bold;letter-spacing:1px}
.sub{font-size:11px}
.meta{font-size:11px;margin:1px 0}
.divider{border-top:1px dashed #000;margin:4px 0}
.item{display:flex;gap:6px;margin:2px 0}
.qty{font-weight:bold;min-width:20px}
.dish{}
.note{font-size:10px;color:#555;margin-left:26px;margin-bottom:1px}
@media print{@page{margin:0}}
</style></head><body>
<div class="center">
<div class="title">${escHtml(label)}</div>
<div class="sub">${escHtml(rName)}</div>
</div>
<div class="meta">Order ID: ${escHtml(first.orderNumber)}</div>
<div class="divider"></div>
${itemRows}
<div class="divider"></div>
<div class="meta">Table : ${escHtml(first.tableName)}</div>
<div class="meta">Date  : ${escHtml(dt)}</div>
<div class="meta">Waiter: ${escHtml(first.waiterName ?? '—')}</div>
</body></html>`

      const frame = printFrameRef.current
      if (!frame) continue
      const doc = frame.contentDocument ?? frame.contentWindow?.document
      if (!doc) continue
      doc.open()
      doc.write(html)
      doc.close()
      setTimeout(() => frame.contentWindow?.print(), 400)
    }
  }, [])

  const fetchPending = useCallback(async (silent = false) => {
    const token = getToken()
    if (!token) { onLogout(); return }

    try {
      const res = await apiRequest({ method: 'GET', path: '/api/mobile/kitchen/pending', token })
      if (res.status === 401) { onLogout(); return }

      const data = parseResponse<PendingResponse>(res)
      const incoming = data.items ?? []

      if (data.restaurantName) setRestaurantName(data.restaurantName)
      if (data.branchName) setBranchName(data.branchName)
      if (data.branchType) setBranchType(data.branchType)

      setItems(incoming)
      setError(null)

      // Auto-print new items we haven't seen before
      if (!silent) {
        const seen = getSeenIds()
        const freshItems = incoming.filter(i => i.kitchenStatus === 'new' && !seen.has(i.id))
        if (freshItems.length > 0) {
          printTickets(freshItems, data.restaurantName, data.branchName, data.branchType)
        }
      }

      saveSeenIds(incoming.map(i => i.id))
    } catch {
      setError('Connection lost. Retrying…')
    }
  }, [onLogout, printTickets])

  // On mount: mark current items as seen (no print), then start polling with printing
  useEffect(() => {
    void fetchPending(true)
    const timer = setInterval(() => void fetchPending(false), POLL_MS)
    return () => clearInterval(timer)
  }, [fetchPending])

  async function advanceStatus(item: KitchenItem) {
    const nextMap: Record<string, string> = {
      new: 'in_kitchen',
      in_kitchen: 'ready',
      ready: 'served',
    }
    const nextStatus = nextMap[item.kitchenStatus]
    if (!nextStatus) return

    const token = getToken()
    if (!token) { onLogout(); return }

    setUpdating(s => new Set(s).add(item.id))
    try {
      await apiRequest({
        method: 'PATCH',
        path: `/api/mobile/kitchen/item/${item.id}`,
        token,
        body: { kitchenStatus: nextStatus },
      })
      await fetchPending(true)
    } catch {
      // Next poll will catch up
    } finally {
      setUpdating(s => { const n = new Set(s); n.delete(item.id); return n })
    }
  }

  async function manualRefresh() {
    setRefreshing(true)
    await fetchPending(true)
    setRefreshing(false)
  }

  const newItems = items.filter(i => i.kitchenStatus === 'new')
  const cookingItems = items.filter(i => i.kitchenStatus === 'in_kitchen')
  const readyItems = items.filter(i => i.kitchenStatus === 'ready')

  const branchLabel = branchType === 'bar' ? 'BAR' : 'KITCHEN'

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* Header */}
      <header className="flex-none bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-orange-400 uppercase tracking-widest">{branchLabel}</span>
            {branchName && (
              <span className="text-sm font-semibold text-white truncate">{branchName}</span>
            )}
          </div>
          {restaurantName && (
            <p className="text-xs text-gray-500 truncate">{restaurantName} · {user.name}</p>
          )}
        </div>

        {error && (
          <span className="text-xs text-red-400 shrink-0">{error}</span>
        )}

        <button
          onClick={manualRefresh}
          disabled={refreshing}
          className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>

        <button
          onClick={onLogout}
          className="p-2 rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </header>

      {/* KDS Columns */}
      <div className="flex-1 flex gap-0 overflow-hidden">
        {/* NEW */}
        <Column
          title="New"
          icon={<Utensils className="h-4 w-4" />}
          count={newItems.length}
          accentClass="border-rose-500/50 bg-rose-500/5"
          badgeClass="bg-rose-500/20 text-rose-400 border border-rose-500/30"
          items={newItems}
          actionLabel="Start"
          actionClass="bg-orange-500 hover:bg-orange-400 text-white"
          onAction={advanceStatus}
          updating={updating}
        />

        {/* IN PROGRESS */}
        <Column
          title="Cooking"
          icon={<ChefHat className="h-4 w-4" />}
          count={cookingItems.length}
          accentClass="border-amber-500/50 bg-amber-500/5"
          badgeClass="bg-amber-500/20 text-amber-400 border border-amber-500/30"
          items={cookingItems}
          actionLabel="Ready"
          actionClass="bg-blue-600 hover:bg-blue-500 text-white"
          onAction={advanceStatus}
          updating={updating}
        />

        {/* READY */}
        <Column
          title="Ready"
          icon={<CheckCircle2 className="h-4 w-4" />}
          count={readyItems.length}
          accentClass="border-emerald-500/50 bg-emerald-500/5"
          badgeClass="bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
          items={readyItems}
          actionLabel="Served"
          actionClass="bg-gray-700 hover:bg-gray-600 text-gray-300"
          onAction={advanceStatus}
          updating={updating}
        />
      </div>

      {/* Hidden print iframe */}
      <iframe
        ref={printFrameRef}
        style={{ display: 'none', position: 'absolute', width: 0, height: 0 }}
        title="kitchen-print"
      />
    </div>
  )
}

interface ColumnProps {
  title: string
  icon: React.ReactNode
  count: number
  accentClass: string
  badgeClass: string
  items: KitchenItem[]
  actionLabel: string
  actionClass: string
  onAction: (item: KitchenItem) => void
  updating: Set<string>
}

function Column({
  title,
  icon,
  count,
  accentClass,
  badgeClass,
  items,
  actionLabel,
  actionClass,
  onAction,
  updating,
}: ColumnProps) {
  return (
    <div className={`flex-1 flex flex-col min-w-0 border-r border-gray-800 last:border-r-0`}>
      {/* Column header */}
      <div className={`flex-none px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 ${accentClass} border-l-2`}>
        <span className="text-gray-400">{icon}</span>
        <span className="text-sm font-semibold text-white">{title}</span>
        <span className={`ml-auto text-xs font-bold px-2 py-0.5 rounded-full ${badgeClass}`}>
          {count}
        </span>
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-gray-700">
            <Clock className="h-6 w-6 mb-2" />
            <span className="text-xs">Nothing here</span>
          </div>
        )}
        {items.map(item => (
          <ItemCard
            key={item.id}
            item={item}
            actionLabel={actionLabel}
            actionClass={actionClass}
            onAction={onAction}
            isUpdating={updating.has(item.id)}
          />
        ))}
      </div>
    </div>
  )
}

interface ItemCardProps {
  item: KitchenItem
  actionLabel: string
  actionClass: string
  onAction: (item: KitchenItem) => void
  isUpdating: boolean
}

function ItemCard({ item, actionLabel, actionClass, onAction, isUpdating }: ItemCardProps) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 space-y-2">
      {/* Order header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-white leading-tight">{item.tableName}</p>
          <p className="text-xs text-gray-500">{item.orderNumber}</p>
        </div>
        <span className="text-xs text-gray-600 shrink-0">{fmtTime(item.addedAt)}</span>
      </div>

      {/* Dish */}
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-black text-orange-400">{item.qty}×</span>
        <span className="text-sm font-semibold text-white">{item.dishName}</span>
      </div>

      {/* Notes */}
      {item.notes && (
        <p className="text-xs text-amber-300/80 bg-amber-500/10 rounded px-2 py-1">
          ↳ {item.notes}
        </p>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-xs text-gray-600 truncate">
          {item.waiterName ?? '—'}
        </span>
        <button
          onClick={() => onAction(item)}
          disabled={isUpdating}
          className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${actionClass}`}
        >
          {isUpdating ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : null}
          {actionLabel}
        </button>
      </div>
    </div>
  )
}

'use client'
import { useState, useEffect, useCallback } from 'react'
import { Users, CheckCircle2, Clock, XCircle, Sparkles, Plus, X, Trash2, RefreshCw, QrCode, Download, ExternalLink } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'

type TableStatus = 'available' | 'occupied' | 'reserved' | 'cleaning'
type Table = { id: string; name: string; seats: number; status: TableStatus }
type PendingCount = Record<string, number> // tableId -> pending item count

const STATUS_CONFIG = {
  available: { label:'Available', color:'bg-green-500', text:'text-green-700', bg:'bg-green-50 border-green-200', icon: CheckCircle2 },
  occupied:  { label:'Occupied',  color:'bg-orange-500', text:'text-orange-700', bg:'bg-orange-50 border-orange-200', icon: Users },
  reserved:  { label:'Reserved',  color:'bg-amber-500',  text:'text-amber-700',  bg:'bg-amber-50 border-amber-200',   icon: Clock },
  cleaning:  { label:'Cleaning',  color:'bg-gray-400',  text:'text-gray-600',  bg:'bg-gray-50 border-gray-200',   icon: XCircle },
}

export default function RestaurantTables({ onAskJesse, restaurantId }: { onAskJesse?: () => void; restaurantId?: string }) {
  const [tables, setTables] = useState<Table[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ name: '', seats: '4', status: 'available' as TableStatus })
  const [filter, setFilter] = useState<TableStatus | 'all'>('all')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [pendingCounts, setPendingCounts] = useState<PendingCount>({})
  const [qrTable, setQrTable] = useState<Table | null>(null)
  const appUrl = typeof window !== 'undefined' ? window.location.origin : ''

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [tablesRes, ordersRes] = await Promise.all([
        fetch('/api/restaurant/tables-db', { credentials: 'include' }),
        fetch('/api/restaurant/pending', { credentials: 'include' }),
      ])
      const tablesData = await tablesRes.json()
      setTables(Array.isArray(tablesData) ? tablesData : [])
      if (ordersRes.ok) {
        const orders = await ordersRes.json()
        const counts: PendingCount = {}
        if (Array.isArray(orders)) {
          orders.forEach((o: any) => {
            if (o.tableId && o.status !== 'ready') counts[o.tableId] = (counts[o.tableId] || 0) + 1
          })
        }
        setPendingCounts(counts)
      }
    } catch { setTables([]) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const handler = () => load()
    window.addEventListener('refreshTables', handler)
    return () => window.removeEventListener('refreshTables', handler)
  }, [load])

  async function addTable() {
    if (!form.name.trim()) return
    setSaving(true)
    await fetch('/api/restaurant/tables-db', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ name: form.name.trim(), seats: parseInt(form.seats) || 4, status: form.status })
    })
    setForm({ name: '', seats: '4', status: 'available' })
    setShowForm(false); setSaving(false); load()
  }

  async function cycleStatus(table: Table) {
    const order: TableStatus[] = ['available', 'occupied', 'reserved', 'cleaning']
    const next = order[(order.indexOf(table.status) + 1) % order.length]
    setTables(prev => prev.map(t => t.id === table.id ? { ...t, status: next } : t))
    await fetch(`/api/restaurant/tables-db/${table.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ status: next })
    })
  }

  async function deleteTable(id: string) {
    setTables(prev => prev.filter(t => t.id !== id)); setDeleteId(null)
    await fetch(`/api/restaurant/tables-db/${id}`, { method: 'DELETE', credentials: 'include' })
  }

  const counts = {
    available: tables.filter(t => t.status==='available').length,
    occupied:  tables.filter(t => t.status==='occupied').length,
    reserved:  tables.filter(t => t.status==='reserved').length,
    cleaning:  tables.filter(t => t.status==='cleaning').length,
  }
  const filtered = filter === 'all' ? tables : tables.filter(t => t.status === filter)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Floor Plan</h2>
          <p className="text-sm text-gray-500">{counts.occupied} occupied / {tables.length} total</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50" title="Refresh">
            <RefreshCw className={`h-4 w-4 text-gray-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={onAskJesse} className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-orange-300 text-orange-600 bg-white hover:bg-orange-50 transition-colors">
            <Sparkles className="h-3.5 w-3.5"/> Ask Jesse
          </button>
          <button onClick={() => setShowForm(true)} className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
            <Plus className="h-4 w-4"/> Add Table
          </button>
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-gray-900">Add New Table</h3>
              <button onClick={() => setShowForm(false)}><X className="h-5 w-5 text-gray-400 hover:text-gray-600"/></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Table Name / Number</label>
                <input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. T1, Terrace 1, VIP"
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"/>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Seats</label>
                <input type="number" min="1" max="50" value={form.seats} onChange={e=>setForm(f=>({...f,seats:e.target.value}))}
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"/>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Initial Status</label>
                <select value={form.status} onChange={e=>setForm(f=>({...f,status:e.target.value as TableStatus}))}
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
                  <option value="available">Available</option>
                  <option value="occupied">Occupied</option>
                  <option value="reserved">Reserved</option>
                  <option value="cleaning">Cleaning</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setShowForm(false)} className="flex-1 px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={addTable} disabled={!form.name.trim() || saving} className="flex-1 px-4 py-2 text-sm bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg disabled:opacity-40">
                {saving ? 'Adding…' : 'Add Table'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-6 text-center space-y-4">
            <p className="font-semibold text-gray-800">Delete this table?</p>
            <p className="text-sm text-gray-500">This action cannot be undone.</p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={() => deleteTable(deleteId)} className="flex-1 px-4 py-2 text-sm bg-red-500 hover:bg-red-600 text-white font-medium rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-6 w-6 text-gray-400 animate-spin mr-2"/>
          <span className="text-gray-400 text-sm">Loading tables…</span>
        </div>
      )}

      {!loading && tables.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-2xl bg-orange-100 flex items-center justify-center mb-4">
            <Users className="h-8 w-8 text-orange-400"/>
          </div>
          <h3 className="font-semibold text-gray-700 text-lg mb-1">No tables yet</h3>
          <p className="text-sm text-gray-400 max-w-xs">Add your restaurant's tables to start tracking occupancy and reservations.</p>
          <button onClick={() => setShowForm(true)} className="mt-4 flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-5 py-2.5 rounded-xl">
            <Plus className="h-4 w-4"/> Add First Table
          </button>
        </div>
      )}

      {!loading && tables.length > 0 && (
        <>
          <div className="grid grid-cols-4 gap-3">
            {(Object.entries(counts) as [TableStatus, number][]).map(([status, count]) => (
              <div key={status} onClick={() => setFilter(f => f === status ? 'all' : status)}
                className={`bg-white rounded-xl border p-3 shadow-sm cursor-pointer transition-all ${filter===status?'ring-2 ring-orange-400':''}`}>
                <div className={`h-2 w-8 rounded-full mb-2 ${STATUS_CONFIG[status].color}`}/>
                <p className="text-xs text-gray-500">{STATUS_CONFIG[status].label}</p>
                <p className="text-2xl font-bold text-gray-900">{count}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {filtered.map(table => {
              const { bg, text, icon: Icon, label } = STATUS_CONFIG[table.status]
              const pendingCount = pendingCounts[table.id] || 0
              const qrUrl = restaurantId ? `${appUrl}/order/${restaurantId}/${table.id}` : ''
              return (
                <div key={table.id} className={`relative group rounded-xl border-2 p-3 transition-all ${bg}`}>
                  {/* Delete button */}
                  <button onClick={() => setDeleteId(table.id)}
                    className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 p-0.5 rounded bg-white/80 hover:bg-red-50 transition-opacity">
                    <Trash2 className="h-3 w-3 text-red-400"/>
                  </button>
                  {/* Pending orders badge */}
                  {pendingCount > 0 && (
                    <div className="absolute -top-2 -left-2 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 shadow">
                      {pendingCount}
                    </div>
                  )}
                  <div onClick={() => cycleStatus(table)} className="cursor-pointer">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-gray-900 text-sm">{table.name}</span>
                      <Icon className={`h-4 w-4 ${text}`}/>
                    </div>
                    <p className="text-xs text-gray-500">{table.seats} seats</p>
                    <p className={`text-xs font-medium mt-1 ${text}`}>{label}</p>
                    {pendingCount > 0 && (
                      <p className="text-[10px] font-semibold text-red-500 mt-0.5">{pendingCount} item{pendingCount > 1 ? 's' : ''} ordered</p>
                    )}
                  </div>
                  {/* QR button */}
                  {qrUrl && (
                    <button onClick={() => setQrTable(table)}
                      className="mt-2 w-full flex items-center justify-center gap-1 text-[10px] font-semibold text-gray-500 hover:text-orange-600 hover:bg-orange-50 rounded-lg py-1 transition-colors border border-gray-200 border-dashed">
                      <QrCode className="h-3 w-3"/>QR
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <p className="text-xs text-gray-400 text-center">Click a table to cycle its status · Hover to delete</p>
        </>
      )}

      {/* QR Code Modal */}
      {qrTable && restaurantId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-6 space-y-4 text-center">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-gray-900">QR Code — {qrTable.name}</h3>
              <button onClick={() => setQrTable(null)}><X className="h-5 w-5 text-gray-400 hover:text-gray-600"/></button>
            </div>
            <p className="text-xs text-gray-500">Customers scan this to see the menu and place an order.</p>
            <div className="flex justify-center p-4 bg-gray-50 rounded-xl">
              <QRCodeSVG
                value={`${appUrl}/order/${restaurantId}/${qrTable.id}`}
                size={180}
                includeMargin={true}
              />
            </div>
            <p className="text-[10px] text-gray-400 break-all">{appUrl}/order/{restaurantId}/{qrTable.id}</p>
            <div className="flex gap-2">
              <a href={`${appUrl}/order/${restaurantId}/${qrTable.id}`} target="_blank" rel="noopener noreferrer"
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold border border-gray-200 rounded-lg py-2 hover:bg-gray-50">
                <ExternalLink className="h-3.5 w-3.5"/>Preview
              </a>
              <button onClick={() => window.print()}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold bg-orange-500 hover:bg-orange-600 text-white rounded-lg py-2">
                <Download className="h-3.5 w-3.5"/>Print
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

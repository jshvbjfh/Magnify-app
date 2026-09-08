'use client'
import { useState, useEffect, useCallback } from 'react'
import { BedDouble, Users, Sparkles, Wrench, Plus, X, Trash2, RefreshCw } from 'lucide-react'

// The room list for venues that let rooms as well as serve food.
//
// Built as the twin of RestaurantTables on purpose: a room is a named thing
// carrying a status a manager taps through, which is exactly what a table is.
// A manager who already knows the floor plan needs no second explanation here.
//
// What this screen is NOT: a booking system. There is no arrival, no departure
// and no rate calendar, because none of that is what the hotels asking for
// Magnify are missing — they are missing one place that knows a room exists so
// a guest can eventually be charged to it.

type RoomStatus = 'vacant' | 'occupied' | 'dirty' | 'maintenance'
type Room = {
  id: string
  name: string
  type: string
  capacity: number
  rate: number
  status: RoomStatus
  floor: string | null
  notes: string | null
}

const STATUS_CONFIG: Record<RoomStatus, { label: string; color: string; text: string; bg: string; icon: typeof BedDouble }> = {
  vacant:      { label: 'Vacant',    color: 'bg-green-500',  text: 'text-green-700',  bg: 'bg-green-50 border-green-200',   icon: BedDouble },
  occupied:    { label: 'Occupied',  color: 'bg-orange-500', text: 'text-orange-700', bg: 'bg-orange-50 border-orange-200', icon: Users },
  dirty:       { label: 'Cleaning',  color: 'bg-amber-500',  text: 'text-amber-700',  bg: 'bg-amber-50 border-amber-200',   icon: Sparkles },
  maintenance: { label: 'Out of use', color: 'bg-gray-400',  text: 'text-gray-600',   bg: 'bg-gray-50 border-gray-200',     icon: Wrench },
}

// Tapping a room walks it round the day a room actually has: someone checks in,
// they leave and it needs cleaning, it is cleaned and sells again. Maintenance
// is not in the loop — a room goes out of use because something broke, which is
// a decision, not the next step of a cycle — so it is set from the form and
// tapping it returns it to service.
const STATUS_CYCLE: Record<RoomStatus, RoomStatus> = {
  vacant: 'occupied',
  occupied: 'dirty',
  dirty: 'vacant',
  maintenance: 'vacant',
}

const ROOM_TYPES = ['single', 'double', 'twin', 'triple', 'suite', 'family']

const EMPTY_FORM = { name: '', type: 'double', capacity: '2', rate: '', floor: '', status: 'vacant' as RoomStatus }

export default function RestaurantRooms() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [filter, setFilter] = useState<RoomStatus | 'all'>('all')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(rooms.length === 0)
    try {
      const res = await fetch('/api/restaurant/rooms', { credentials: 'include' })
      const data = await res.json()
      setRooms(Array.isArray(data) ? data : [])
    } catch {
      setError('Could not load rooms')
    } finally {
      setLoading(false)
    }
  }, [rooms.length])

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function addRoom() {
    if (!form.name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/restaurant/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: form.name.trim(),
          type: form.type,
          capacity: form.capacity,
          rate: form.rate,
          floor: form.floor,
          status: form.status,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error || 'Could not add room'); return }
      setRooms(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })))
      setForm(EMPTY_FORM)
      setShowForm(false)
    } catch {
      setError('Could not add room')
    } finally {
      setSaving(false)
    }
  }

  // Optimistic: the tap has to feel instant on a reception desk. If the server
  // refuses, put the old status straight back rather than leaving the grid
  // showing a state the database does not hold.
  async function cycleStatus(room: Room) {
    const next = STATUS_CYCLE[room.status]
    const previous = room.status
    setRooms(prev => prev.map(r => (r.id === room.id ? { ...r, status: next } : r)))
    try {
      const res = await fetch(`/api/restaurant/rooms/${room.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: next }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setRooms(prev => prev.map(r => (r.id === room.id ? { ...r, status: previous } : r)))
      setError('Could not save room status')
    }
  }

  async function deleteRoom(id: string) {
    setDeleteId(null)
    const previous = rooms
    setRooms(prev => prev.filter(r => r.id !== id))
    try {
      const res = await fetch(`/api/restaurant/rooms/${id}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) throw new Error()
    } catch {
      setRooms(previous)
      setError('Could not delete room')
    }
  }

  const counts = {
    vacant: rooms.filter(r => r.status === 'vacant').length,
    occupied: rooms.filter(r => r.status === 'occupied').length,
    dirty: rooms.filter(r => r.status === 'dirty').length,
    maintenance: rooms.filter(r => r.status === 'maintenance').length,
  }
  // Out-of-use rooms cannot be sold, so they are not part of what "full" means.
  const sellable = rooms.length - counts.maintenance
  const occupancy = sellable > 0 ? Math.round((counts.occupied / sellable) * 100) : 0
  const filtered = filter === 'all' ? rooms : rooms.filter(r => r.status === filter)

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-gray-800">Rooms</h2>
          <p className="text-sm text-gray-500">
            {rooms.length === 0 ? 'No rooms yet' : `${counts.occupied} of ${sellable} let · ${occupancy}% full`}
          </p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <button onClick={load} className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50" title="Refresh">
            <RefreshCw className={`h-4 w-4 text-gray-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => { setError(null); setShowForm(true) }}
            className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-3 sm:px-4 py-2 rounded-lg transition-colors">
            <Plus className="h-4 w-4" />
            <span>Add Room</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          <span>{error}</span>
          <button onClick={() => setError(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-gray-900">Add New Room</h3>
              <button onClick={() => setShowForm(false)}><X className="h-5 w-5 text-gray-400 hover:text-gray-600" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Room Number</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. 101, Cottage 2"
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Type</label>
                  <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                    className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm capitalize focus:outline-none focus:ring-2 focus:ring-orange-300">
                    {ROOM_TYPES.map(t => <option key={t} value={t} className="capitalize">{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Sleeps</label>
                  <input type="number" min="1" max="20" value={form.capacity} onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))}
                    className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Rate / night</label>
                  <input type="number" min="0" value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} placeholder="0"
                    className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Floor</label>
                  <input value={form.floor} onChange={e => setForm(f => ({ ...f, floor: e.target.value }))} placeholder="Optional"
                    className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Initial Status</label>
                <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as RoomStatus }))}
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
                  {(Object.keys(STATUS_CONFIG) as RoomStatus[]).map(s => (
                    <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setShowForm(false)} className="flex-1 px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={addRoom} disabled={!form.name.trim() || saving}
                className="flex-1 px-4 py-2 text-sm bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg disabled:opacity-40">
                {saving ? 'Adding…' : 'Add Room'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-6 text-center space-y-4">
            <p className="font-semibold text-gray-800">Delete this room?</p>
            <p className="text-sm text-gray-500">It stops appearing everywhere. Past bills keep it.</p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={() => deleteRoom(deleteId)} className="flex-1 px-4 py-2 text-sm bg-red-500 hover:bg-red-600 text-white font-medium rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-6 w-6 text-gray-400 animate-spin mr-2" />
          <span className="text-gray-400 text-sm">Loading rooms…</span>
        </div>
      )}

      {!loading && rooms.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-2xl bg-orange-100 flex items-center justify-center mb-4">
            <BedDouble className="h-8 w-8 text-orange-400" />
          </div>
          <h3 className="font-semibold text-gray-700 text-lg mb-1">No rooms yet</h3>
          <p className="text-sm text-gray-400 max-w-xs">Add your rooms the same way you added tables, and reception can track who is in which one.</p>
          <button onClick={() => setShowForm(true)} className="mt-4 flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-5 py-2.5 rounded-xl">
            <Plus className="h-4 w-4" /> Add First Room
          </button>
        </div>
      )}

      {!loading && rooms.length > 0 && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {(Object.entries(counts) as [RoomStatus, number][]).map(([status, count]) => (
              <div key={status} onClick={() => setFilter(f => (f === status ? 'all' : status))}
                className={`bg-white rounded-xl border p-3 shadow-sm cursor-pointer transition-all ${filter === status ? 'ring-2 ring-orange-400' : ''}`}>
                <div className={`h-2 w-8 rounded-full mb-2 ${STATUS_CONFIG[status].color}`} />
                <p className="text-xs text-gray-500">{STATUS_CONFIG[status].label}</p>
                <p className="text-2xl font-bold text-gray-900">{count}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {filtered.map(room => {
              const { bg, text, icon: Icon, label } = STATUS_CONFIG[room.status]
              return (
                <div key={room.id} className={`relative group rounded-xl border-2 p-3 transition-all ${bg}`}>
                  <button onClick={() => setDeleteId(room.id)}
                    className="absolute top-1.5 right-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-0.5 rounded bg-white/80 hover:bg-red-50 transition-opacity">
                    <Trash2 className="h-3 w-3 text-red-400" />
                  </button>
                  <div onClick={() => cycleStatus(room)} className="cursor-pointer">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-gray-900 text-sm">{room.name}</span>
                      <Icon className={`h-4 w-4 ${text}`} />
                    </div>
                    <p className="text-xs text-gray-500 capitalize">{room.type} · sleeps {room.capacity}</p>
                    {room.rate > 0 && (
                      <p className="text-xs text-gray-500">{room.rate.toLocaleString()} / night</p>
                    )}
                    <p className={`text-xs font-medium mt-1 ${text}`}>{label}</p>
                    {room.floor && <p className="text-[10px] text-gray-400 mt-0.5">Floor {room.floor}</p>}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="text-xs text-gray-400 text-center">Tap a room to move it on · Use the top-right bin icon to delete</p>
        </>
      )}
    </div>
  )
}

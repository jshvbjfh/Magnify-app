'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BranchBadge } from '@/contexts/RestaurantBranchContext'
import { Boxes, Plus, X, ArrowDownToLine, ArrowUpFromLine, SlidersHorizontal, Pencil, Trash2, History, AlertTriangle } from 'lucide-react'

// Operating equipments: the non-food supplies a venue buys to run itself.
//
// Nothing here talks to Stock, recipes or costing. That is the whole point of
// the feature — a bar of soap must never be able to reach food cost — so this
// screen has its own endpoints and its own tables and shares no helper with the
// inventory screen beyond formatting.

type Equipment = {
  id: string
  name: string
  unit: string
  quantity: number
  unitCost: number
  reorderLevel: number
  category: string | null
  notes: string | null
  isActive: boolean
}

type Movement = {
  id: string
  equipmentId: string
  kind: 'purchase' | 'issue' | 'adjustment'
  quantity: number
  unitCost: number
  totalCost: number
  supplier: string | null
  note: string | null
  recordedBy: string | null
  occurredAt: string
  equipment?: { id: string; name: string; unit: string }
}

const fmt = (n: number) => n.toLocaleString('en-RW', { maximumFractionDigits: 0 })
const fmtQty = (n: number) => n.toLocaleString('en-RW', { maximumFractionDigits: 2 })

const MOVEMENT_LABEL: Record<Movement['kind'], string> = {
  purchase: 'Received',
  issue: 'Issued',
  adjustment: 'Correction',
}

const EMPTY_ITEM_FORM = { name: '', unit: 'piece', category: '', quantity: '', unitCost: '', reorderLevel: '', notes: '' }
const EMPTY_MOVE_FORM = { kind: 'purchase' as Movement['kind'], quantity: '', unitCost: '', supplier: '', note: '', recordedBy: '' }

export default function OperatingEquipment() {
  const [items, setItems] = useState<Equipment[]>([])
  const [movements, setMovements] = useState<Movement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)

  const [itemForm, setItemForm] = useState(EMPTY_ITEM_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showItemModal, setShowItemModal] = useState(false)
  const [saving, setSaving] = useState(false)

  const [moveTarget, setMoveTarget] = useState<Equipment | null>(null)
  const [moveForm, setMoveForm] = useState(EMPTY_MOVE_FORM)
  const [historyFor, setHistoryFor] = useState<Equipment | null>(null)

  const load = useCallback(async () => {
    try {
      const [itemsRes, movesRes] = await Promise.all([
        fetch('/api/restaurant/operating-equipment').then(r => r.json()),
        fetch('/api/restaurant/operating-equipment/movements?limit=200').then(r => r.json()),
      ])
      setItems(Array.isArray(itemsRes) ? itemsRes : [])
      setMovements(Array.isArray(movesRes) ? movesRes : [])
      setError(null)
    } catch {
      setError('Could not load operating equipments')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const categories = useMemo(() => {
    const names = new Set<string>()
    for (const item of items) if (item.category) names.add(item.category)
    return Array.from(names).sort((a, b) => a.localeCompare(b))
  }, [items])

  const visibleItems = useMemo(
    () => (activeCategory === null ? items : items.filter(i => i.category === activeCategory)),
    [items, activeCategory],
  )

  // Zero means "never warn", so an item with no reorder level set is never low.
  const lowStock = useMemo(
    () => items.filter(i => i.reorderLevel > 0 && i.quantity <= i.reorderLevel),
    [items],
  )
  const totalValue = useMemo(
    () => items.reduce((sum, i) => sum + i.quantity * i.unitCost, 0),
    [items],
  )

  function openAdd() {
    setEditingId(null)
    setItemForm(EMPTY_ITEM_FORM)
    setError(null)
    setShowItemModal(true)
  }

  function openEdit(item: Equipment) {
    setEditingId(item.id)
    setItemForm({
      name: item.name,
      unit: item.unit,
      category: item.category ?? '',
      // Quantity is not editable on an existing item — it moves only through the
      // ledger, so the field is hidden rather than pre-filled in edit mode.
      quantity: '',
      unitCost: item.unitCost ? String(item.unitCost) : '',
      reorderLevel: item.reorderLevel ? String(item.reorderLevel) : '',
      notes: item.notes ?? '',
    })
    setError(null)
    setShowItemModal(true)
  }

  async function saveItem() {
    if (!itemForm.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    try {
      const payload = {
        ...(editingId ? { id: editingId } : {}),
        name: itemForm.name.trim(),
        unit: itemForm.unit.trim() || 'piece',
        category: itemForm.category.trim() || null,
        unitCost: itemForm.unitCost === '' ? null : Number(itemForm.unitCost),
        reorderLevel: itemForm.reorderLevel === '' ? null : Number(itemForm.reorderLevel),
        notes: itemForm.notes.trim() || null,
        ...(editingId ? {} : { quantity: itemForm.quantity === '' ? 0 : Number(itemForm.quantity) }),
      }
      const res = await fetch('/api/restaurant/operating-equipment', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error || 'Could not save'); return }
      setShowItemModal(false)
      await load()
    } catch {
      setError('Could not save')
    } finally {
      setSaving(false)
    }
  }

  async function removeItem(item: Equipment) {
    if (!confirm(`Remove ${item.name}? Its history stays recorded.`)) return
    try {
      const res = await fetch(`/api/restaurant/operating-equipment?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) { setError(data?.error || 'Could not remove'); return }
      await load()
    } catch {
      setError('Could not remove')
    }
  }

  function openMove(item: Equipment, kind: Movement['kind']) {
    setMoveTarget(item)
    setMoveForm({ ...EMPTY_MOVE_FORM, kind, unitCost: kind === 'purchase' && item.unitCost ? String(item.unitCost) : '' })
    setError(null)
  }

  async function saveMovement() {
    if (!moveTarget) return
    if (moveForm.quantity === '' || Number(moveForm.quantity) === 0) { setError('Enter a quantity'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/restaurant/operating-equipment/movements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          equipmentId: moveTarget.id,
          kind: moveForm.kind,
          quantity: Number(moveForm.quantity),
          unitCost: moveForm.unitCost === '' ? null : Number(moveForm.unitCost),
          supplier: moveForm.supplier.trim() || null,
          note: moveForm.note.trim() || null,
          recordedBy: moveForm.recordedBy.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error || 'Could not record'); return }
      setMoveTarget(null)
      await load()
    } catch {
      setError('Could not record')
    } finally {
      setSaving(false)
    }
  }

  const historyRows = useMemo(
    () => (historyFor ? movements.filter(m => m.equipmentId === historyFor.id) : movements),
    [movements, historyFor],
  )

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Loading operating equipments…</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-gray-900">Operating Equipments</h1>
          <BranchBadge />
        </div>
        <button type="button" onClick={openAdd}
          className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600">
          <Plus className="h-4 w-4" /> Add item
        </button>
      </div>

      <p className="text-sm text-gray-500">
        Soap, slippers, mop sticks, bin liners — what you buy to run the place, kept apart from food stock.
      </p>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500">Total Items</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{items.length}</p>
        </div>
        <div className={`bg-white rounded-xl border p-4 shadow-sm text-center ${lowStock.length > 0 ? 'border-red-200' : 'border-gray-200'}`}>
          <p className="text-xs text-gray-500">Low Stock Alerts</p>
          <p className={`text-2xl font-bold mt-1 ${lowStock.length > 0 ? 'text-red-600' : 'text-gray-900'}`}>{lowStock.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500">Value On Hand</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{fmt(totalValue)} RWF</p>
        </div>
      </div>

      {categories.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 px-3 py-2 shadow-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setActiveCategory(null)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${activeCategory === null ? 'bg-orange-500 text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}>
              All <span className="opacity-70">{items.length}</span>
            </button>
            {categories.map(cat => (
              <button key={cat} type="button" onClick={() => setActiveCategory(cat)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${activeCategory === cat ? 'bg-orange-500 text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}>
                {cat} <span className="opacity-70">{items.filter(i => i.category === cat).length}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {visibleItems.length === 0 ? (
          <div className="p-10 text-center">
            <Boxes className="h-8 w-8 text-gray-300 mx-auto" />
            <p className="mt-3 text-sm font-semibold text-gray-700">Nothing here yet</p>
            <p className="mt-1 text-xs text-gray-500">Add the supplies this station keeps — soap, slippers, mop sticks.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Item</th>
                  <th className="text-right font-semibold px-4 py-2.5">On hand</th>
                  <th className="text-right font-semibold px-4 py-2.5">Reorder at</th>
                  <th className="text-right font-semibold px-4 py-2.5">Unit cost</th>
                  <th className="text-right font-semibold px-4 py-2.5">Value</th>
                  <th className="text-right font-semibold px-4 py-2.5">Record</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visibleItems.map(item => {
                  const isLow = item.reorderLevel > 0 && item.quantity <= item.reorderLevel
                  return (
                    <tr key={item.id} className="hover:bg-gray-50/60">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-900">{item.name}</span>
                          {isLow && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-red-50 border border-red-200 px-2 py-0.5 text-[10px] font-bold text-red-600">
                              <AlertTriangle className="h-3 w-3" /> Low
                            </span>
                          )}
                        </div>
                        {item.category && <p className="text-xs text-gray-400 mt-0.5">{item.category}</p>}
                      </td>
                      <td className={`px-4 py-3 text-right font-bold ${isLow ? 'text-red-600' : 'text-gray-900'}`}>
                        {fmtQty(item.quantity)} <span className="font-normal text-gray-400 text-xs">{item.unit}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {item.reorderLevel > 0 ? fmtQty(item.reorderLevel) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">{item.unitCost > 0 ? fmt(item.unitCost) : '—'}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{fmt(item.quantity * item.unitCost)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" onClick={() => openMove(item, 'purchase')} title="Received"
                            className="rounded-lg border border-gray-200 p-1.5 text-green-600 hover:bg-green-50 hover:border-green-200">
                            <ArrowDownToLine className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => openMove(item, 'issue')} title="Issued"
                            className="rounded-lg border border-gray-200 p-1.5 text-orange-600 hover:bg-orange-50 hover:border-orange-200">
                            <ArrowUpFromLine className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => openMove(item, 'adjustment')} title="Correction"
                            className="rounded-lg border border-gray-200 p-1.5 text-gray-500 hover:bg-gray-100">
                            <SlidersHorizontal className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" onClick={() => setHistoryFor(item)} title="History"
                            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                            <History className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => openEdit(item)} title="Edit"
                            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => void removeItem(item)} title="Remove"
                            className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent activity — the ledger is the only thing that moves a quantity,
          so this doubles as the explanation for every number above. */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-bold text-gray-900">
            {historyFor ? `History — ${historyFor.name}` : 'Recent activity'}
          </h2>
          {historyFor && (
            <button type="button" onClick={() => setHistoryFor(null)}
              className="text-xs font-semibold text-orange-600 hover:text-orange-700">Show all</button>
          )}
        </div>
        {historyRows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-400">Nothing recorded yet.</p>
        ) : (
          <div className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
            {historyRows.slice(0, 100).map(m => (
              <div key={m.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className={`inline-flex w-20 justify-center rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  m.kind === 'purchase' ? 'bg-green-50 text-green-700'
                    : m.kind === 'issue' ? 'bg-orange-50 text-orange-700'
                    : 'bg-gray-100 text-gray-600'
                }`}>
                  {MOVEMENT_LABEL[m.kind]}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-900 truncate">
                    <span className="font-semibold">{m.quantity > 0 ? '+' : ''}{fmtQty(m.quantity)}</span>
                    {' '}
                    <span className="text-gray-400 text-xs">{m.equipment?.unit}</span>
                    {' · '}
                    {m.equipment?.name ?? historyFor?.name}
                  </p>
                  {(m.note || m.supplier || m.recordedBy) && (
                    <p className="text-xs text-gray-400 truncate">
                      {[m.supplier, m.note, m.recordedBy && `by ${m.recordedBy}`].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0">
                  {new Date(m.occurredAt).toLocaleDateString('en-RW', { day: 'numeric', month: 'short' })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {showItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-bold text-gray-900">{editingId ? 'Edit item' : 'Add item'}</h2>
              <button type="button" onClick={() => setShowItemModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Name</label>
                <input autoFocus value={itemForm.name} onChange={e => setItemForm({ ...itemForm, name: e.target.value })}
                  placeholder="Hand soap"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Unit</label>
                  <input value={itemForm.unit} onChange={e => setItemForm({ ...itemForm, unit: e.target.value })}
                    placeholder="piece"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Category</label>
                  <input value={itemForm.category} onChange={e => setItemForm({ ...itemForm, category: e.target.value })}
                    placeholder="Cleaning"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {!editingId && (
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">Opening count</label>
                    <input type="number" value={itemForm.quantity} onChange={e => setItemForm({ ...itemForm, quantity: e.target.value })}
                      placeholder="0"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200" />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Unit cost</label>
                  <input type="number" value={itemForm.unitCost} onChange={e => setItemForm({ ...itemForm, unitCost: e.target.value })}
                    placeholder="0"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Warn below</label>
                  <input type="number" value={itemForm.reorderLevel} onChange={e => setItemForm({ ...itemForm, reorderLevel: e.target.value })}
                    placeholder="0"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Notes</label>
                <input value={itemForm.notes} onChange={e => setItemForm({ ...itemForm, notes: e.target.value })}
                  placeholder="Optional"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200" />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100">
              <button type="button" onClick={() => setShowItemModal(false)}
                className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={() => void saveItem()} disabled={saving || !itemForm.name.trim()}
                className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50">
                {saving ? 'Saving…' : editingId ? 'Save' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}

      {moveTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-bold text-gray-900">{MOVEMENT_LABEL[moveForm.kind]} — {moveTarget.name}</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {fmtQty(moveTarget.quantity)} {moveTarget.unit} on hand
                </p>
              </div>
              <button type="button" onClick={() => setMoveTarget(null)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div className="flex gap-1.5">
                {(['purchase', 'issue', 'adjustment'] as const).map(kind => (
                  <button key={kind} type="button" onClick={() => setMoveForm({ ...moveForm, kind })}
                    className={`flex-1 rounded-lg px-2 py-2 text-xs font-semibold transition-colors ${
                      moveForm.kind === kind ? 'bg-orange-500 text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                    }`}>
                    {MOVEMENT_LABEL[kind]}
                  </button>
                ))}
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">
                  Quantity{moveForm.kind === 'adjustment' ? ' (use a minus sign to reduce)' : ''}
                </label>
                <input autoFocus type="number" value={moveForm.quantity}
                  onChange={e => setMoveForm({ ...moveForm, quantity: e.target.value })}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200" />
              </div>
              {moveForm.kind === 'purchase' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">Unit cost</label>
                    <input type="number" value={moveForm.unitCost}
                      onChange={e => setMoveForm({ ...moveForm, unitCost: e.target.value })}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">Supplier</label>
                    <input value={moveForm.supplier}
                      onChange={e => setMoveForm({ ...moveForm, supplier: e.target.value })}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200" />
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Note</label>
                  <input value={moveForm.note} onChange={e => setMoveForm({ ...moveForm, note: e.target.value })}
                    placeholder={moveForm.kind === 'issue' ? 'To the kitchen' : 'Optional'}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Recorded by</label>
                  <input value={moveForm.recordedBy} onChange={e => setMoveForm({ ...moveForm, recordedBy: e.target.value })}
                    placeholder="Optional"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200" />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100">
              <button type="button" onClick={() => setMoveTarget(null)}
                className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={() => void saveMovement()} disabled={saving || moveForm.quantity === ''}
                className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50">
                {saving ? 'Saving…' : 'Record'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

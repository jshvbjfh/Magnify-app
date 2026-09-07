'use client'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { BranchBadge } from '@/contexts/RestaurantBranchContext'
import { Boxes, X, ArrowDownToLine, ArrowUpFromLine, SlidersHorizontal, Pencil, Trash2, History, AlertTriangle } from 'lucide-react'
import { createInventoryBatchSuffix, formatInventoryBatchId } from '@/lib/inventoryBatch'
import { findItemNameCompletion } from '@/lib/inventorySuggestions'
import { normalizeEquipmentName, toStockUnits } from '@/lib/operatingEquipment'
import {
  DEFAULT_USAGE_UNIT_BY_PURCHASE_UNIT,
  getKnownUnitConversion,
  INVENTORY_UNITS,
  isSameInventoryUnit,
} from '@/lib/inventoryUnits'

// Operating equipments: the non-food supplies a venue buys to run itself.
//
// Nothing here talks to Stock, recipes or costing. That is the whole point of
// the feature — a bar of soap must never be able to reach food cost — so this
// screen has its own endpoints and its own tables, and shares only the batch-id
// and name-completion helpers with the stock screen.
//
// Deliveries are recorded the same way stock is: open a dated batch, then type
// each line straight into the table. Naming an item that does not exist yet
// creates it, so there is no separate "make the item first" step.

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
  batchId: string | null
  purchaseUnit: string | null
  unitsPerPurchaseUnit: number | null
  purchaseQuantity: number | null
  purchaseUnitCost: number | null
  quantity: number
  unitCost: number
  totalCost: number
  supplier: string | null
  note: string | null
  recordedBy: string | null
  occurredAt: string
  createdAt: string
  equipment?: { id: string; name: string; unit: string }
}

const fmt = (n: number) => n.toLocaleString('en-RW', { maximumFractionDigits: 0 })
const fmtQty = (n: number) => n.toLocaleString('en-RW', { maximumFractionDigits: 2 })

const MOVEMENT_LABEL: Record<Movement['kind'], string> = {
  purchase: 'Received',
  issue: 'Issued',
  adjustment: 'Correction',
}

const DELIVERY_COLUMN_LABELS = ['Item', 'Supplier', 'Bought in', 'Qty bought', 'Pack size', 'Counted in', 'Cost per pack', 'Total', ''] as const

const EMPTY_ITEM_FORM = { name: '', unit: 'piece', category: '', unitCost: '', reorderLevel: '', notes: '' }
const EMPTY_MOVE_FORM = { kind: 'purchase' as Movement['kind'], quantity: '', unitCost: '', supplier: '', note: '', recordedBy: '' }
// purchaseUnit is what it is bought in ("bottle"); unit is what stock is
// counted in ("ml"); unitsPerPurchaseUnit is how many of the second are in one
// of the first. Equal units mean a plain purchase and the pack size is 1.
const emptyLineForm = () => ({
  itemName: '',
  supplier: '',
  purchaseUnit: 'piece',
  purchaseQuantity: '',
  unitsPerPurchaseUnit: '',
  unit: 'piece',
  purchaseUnitCost: '',
  category: '',
})

function todayInputValue() {
  const now = new Date()
  const offset = now.getTimezoneOffset()
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10)
}

function parseDateInput(value: string) {
  const parsed = new Date(`${value}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

function formatBatchDateLabel(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString('en-RW', { day: 'numeric', month: 'short', year: 'numeric' })
}

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

  // ── Delivery recorder ────────────────────────────────────────────────────
  // A batch is a suffix plus a date, exactly as on the stock screen: the id is
  // derived from both, so changing the date of an empty batch renames it rather
  // than stranding rows under an id nobody will look for again.
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchSuffix, setBatchSuffix] = useState('')
  const [batchDate, setBatchDate] = useState(todayInputValue())
  const [recorderOpen, setRecorderOpen] = useState(false)
  const [lineForm, setLineForm] = useState(emptyLineForm)
  const [suggestionDismissed, setSuggestionDismissed] = useState(false)
  const [autofillNotice, setAutofillNotice] = useState<string | null>(null)
  const [autofillMatchKey, setAutofillMatchKey] = useState('')

  const load = useCallback(async () => {
    try {
      const [itemsRes, movesRes] = await Promise.all([
        fetch('/api/restaurant/operating-equipment').then(r => r.json()),
        fetch('/api/restaurant/operating-equipment/movements?limit=300').then(r => r.json()),
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

  const activeBatchId = batchOpen && batchSuffix
    ? formatInventoryBatchId(parseDateInput(batchDate), batchSuffix)
    : ''

  const deliveries = useMemo(() => movements.filter(m => m.kind === 'purchase'), [movements])
  const activeBatchLines = useMemo(
    () => (activeBatchId ? deliveries.filter(m => m.batchId === activeBatchId) : []),
    [deliveries, activeBatchId],
  )

  // Every other delivery, newest batch first.
  const deliveryGroups = useMemo(() => {
    const groups = new Map<string, { batchId: string; occurredAt: string; lines: Movement[] }>()
    for (const move of deliveries) {
      if (activeBatchId && move.batchId === activeBatchId) continue
      const key = move.batchId || `single:${move.id}`
      const existing = groups.get(key)
      if (existing) {
        existing.lines.push(move)
        if (move.occurredAt < existing.occurredAt) existing.occurredAt = move.occurredAt
      } else {
        groups.set(key, { batchId: move.batchId || '', occurredAt: move.occurredAt, lines: [move] })
      }
    }
    return Array.from(groups.entries())
      .map(([key, group]) => ({ key, ...group }))
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
  }, [deliveries, activeBatchId])

  // What the recorder offers to complete while a name is being typed. Fed from
  // recorded deliveries so a repeat order is a keystroke, not a retyped line.
  const suggestionSource = useMemo(
    () => deliveries
      .filter(m => m.equipment?.name)
      .map(m => ({ ingredient: { name: m.equipment!.name }, createdAt: m.createdAt, movement: m })),
    [deliveries],
  )
  const itemSuggestion = useMemo(() => {
    if (!recorderOpen || suggestionDismissed) return null
    return findItemNameCompletion(suggestionSource, lineForm.itemName)
  }, [recorderOpen, suggestionDismissed, suggestionSource, lineForm.itemName])

  function presetFromName(name: string) {
    const target = normalizeEquipmentName(name)
    if (!target) return null
    const item = items.find(i => normalizeEquipmentName(i.name) === target)
    const lastLine = suggestionSource.find(entry => normalizeEquipmentName(entry.ingredient.name) === target)?.movement
    if (!item && !lastLine) return null
    // The pack size comes from the last delivery, not the item, because that is
    // where it lives — and it is only a starting point: a bottle that changed
    // size is exactly the case the recorder has to let you correct.
    const unit = item?.unit ?? lastLine?.equipment?.unit ?? 'piece'
    return {
      fields: {
        unit,
        purchaseUnit: lastLine?.purchaseUnit ?? unit,
        unitsPerPurchaseUnit: lastLine?.unitsPerPurchaseUnit ? String(lastLine.unitsPerPurchaseUnit) : '',
        purchaseUnitCost: lastLine?.purchaseUnitCost
          ? String(lastLine.purchaseUnitCost)
          : item?.unitCost ? String(item.unitCost) : '',
        supplier: lastLine?.supplier ?? '',
        category: item?.category ?? '',
      },
      notice: `Filled from your last ${item?.name ?? lastLine?.equipment?.name} entry — edit any field before saving.`,
    }
  }

  /**
   * Choosing what it was bought in proposes how it is counted.
   *
   * A bottle is almost always counted in ml and a box in pieces, and where the
   * pair is a fixed metric one (ltr→ml, kg→g) the factor is filled in too — a
   * thousand typed by hand is a thousand that can be mistyped. All of it stays
   * editable: these are the common cases, not rules.
   */
  function handlePurchaseUnitChange(nextPurchaseUnit: string) {
    const proposedUsage = DEFAULT_USAGE_UNIT_BY_PURCHASE_UNIT[nextPurchaseUnit.toLowerCase()] ?? nextPurchaseUnit
    const known = getKnownUnitConversion(nextPurchaseUnit, proposedUsage)
    setLineForm(current => ({
      ...current,
      purchaseUnit: nextPurchaseUnit,
      unit: proposedUsage,
      unitsPerPurchaseUnit: known != null
        ? String(known)
        : isSameInventoryUnit(nextPurchaseUnit, proposedUsage) ? '1' : current.unitsPerPurchaseUnit,
    }))
  }

  function handleUsageUnitChange(nextUsageUnit: string) {
    const known = getKnownUnitConversion(lineForm.purchaseUnit, nextUsageUnit)
    setLineForm(current => ({
      ...current,
      unit: nextUsageUnit,
      unitsPerPurchaseUnit: known != null
        ? String(known)
        : isSameInventoryUnit(current.purchaseUnit, nextUsageUnit) ? '1' : current.unitsPerPurchaseUnit,
    }))
  }

  function handleLineNameChange(nextName: string) {
    const normalized = normalizeEquipmentName(nextName)
    const preset = presetFromName(nextName)
    const shouldAutofill = Boolean(preset && normalized && autofillMatchKey !== normalized)

    // Every edit re-opens the door to a completion: a dismissal only ever
    // applies to the name that was showing when it was dismissed.
    setSuggestionDismissed(false)
    setLineForm(current => ({ ...current, ...(shouldAutofill ? preset!.fields : {}), itemName: nextName }))

    if (shouldAutofill) {
      setAutofillMatchKey(normalized)
      setAutofillNotice(preset!.notice)
      return
    }
    if (!preset || !normalized) {
      setAutofillMatchKey('')
      setAutofillNotice(null)
    }
  }

  function applySuggestion(name: string) {
    const preset = presetFromName(name)
    setLineForm(current => ({ ...current, ...(preset?.fields ?? {}), itemName: name }))
    setAutofillMatchKey(normalizeEquipmentName(name))
    setAutofillNotice(`Filled from your last ${name} entry — edit any field before saving.`)
    setSuggestionDismissed(false)
  }

  function handleLineNameKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (itemSuggestion) {
      // Enter is never taken from the line: it records, suggestion showing or
      // not. Space takes the completion instead, except where the completion
      // carries on into another word — there a space is far more likely to be
      // what is being typed ("Hand" on the way to "Hand towel").
      const spaceAccepts = event.key === ' ' && !itemSuggestion.remainder.startsWith(' ')
      if (event.key === 'Tab' || spaceAccepts) {
        event.preventDefault()
        applySuggestion(itemSuggestion.itemName)
        return
      }
      if (event.key === 'Escape') {
        // Drop the completion only — Esc must not also close the recorder and
        // take the half-typed line down with it.
        event.preventDefault()
        setSuggestionDismissed(true)
        return
      }
    }
    handleLineKeyDown(event)
  }

  function handleLineKeyDown(event: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      void saveLine()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeRecorder()
    }
  }

  function openBatch() {
    setBatchOpen(true)
    setBatchSuffix(createInventoryBatchSuffix())
    setBatchDate(todayInputValue())
    setRecorderOpen(true)
    setLineForm(emptyLineForm())
    setError(null)
  }

  function openRecorderForBatch(existingBatchId: string, occurredAt: string) {
    if (!existingBatchId) return
    const suffix = existingBatchId.split('-').pop() ?? ''
    if (!suffix) return
    setBatchOpen(true)
    setBatchSuffix(suffix)
    setBatchDate(new Date(occurredAt).toISOString().slice(0, 10))
    setRecorderOpen(true)
    setLineForm(emptyLineForm())
    setAutofillNotice(null)
    setAutofillMatchKey('')
    setError(null)
  }

  function closeRecorder() {
    setRecorderOpen(false)
    setLineForm(emptyLineForm())
    setAutofillNotice(null)
    setAutofillMatchKey('')
    setSuggestionDismissed(false)
  }

  function closeBatch() {
    closeRecorder()
    setBatchOpen(false)
    setBatchSuffix('')
    setBatchDate(todayInputValue())
  }

  async function saveLine() {
    if (!lineForm.itemName.trim()) { setError('Type an item name'); return }
    if (lineForm.purchaseQuantity === '' || Number(lineForm.purchaseQuantity) === 0) { setError('Enter a quantity'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/restaurant/operating-equipment/movements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemName: lineForm.itemName.trim(),
          kind: 'purchase',
          batchId: activeBatchId || null,
          // Sent in the unit it was bought in; the server converts to the unit
          // stock is counted in, so the two can never drift apart.
          purchaseUnit: lineForm.purchaseUnit.trim() || null,
          purchaseQuantity: Number(lineForm.purchaseQuantity),
          unitsPerPurchaseUnit: lineForm.unitsPerPurchaseUnit === '' ? 1 : Number(lineForm.unitsPerPurchaseUnit),
          purchaseUnitCost: lineForm.purchaseUnitCost === '' ? null : Number(lineForm.purchaseUnitCost),
          unit: lineForm.unit.trim() || 'piece',
          category: lineForm.category.trim() || null,
          supplier: lineForm.supplier.trim() || null,
          occurredAt: `${batchDate}T00:00:00`,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error || 'Could not record'); return }
      setError(null)
      // Straight into a fresh line: a delivery is many items, and reopening the
      // recorder by hand for each one is the thing this screen exists to avoid.
      setLineForm({ ...emptyLineForm(), supplier: lineForm.supplier })
      setAutofillNotice(null)
      setAutofillMatchKey('')
      await load()
    } catch {
      setError('Could not record')
    } finally {
      setSaving(false)
    }
  }

  // Edit only — an item is never created here. See the header comment on the
  // delivery button for why there is no counterpart to this.
  function openEdit(item: Equipment) {
    setEditingId(item.id)
    setItemForm({
      name: item.name,
      unit: item.unit,
      category: item.category ?? '',
      unitCost: item.unitCost ? String(item.unitCost) : '',
      reorderLevel: item.reorderLevel ? String(item.reorderLevel) : '',
      notes: item.notes ?? '',
    })
    setError(null)
    setShowItemModal(true)
  }

  async function saveItem() {
    if (!editingId) return
    if (!itemForm.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/restaurant/operating-equipment', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingId,
          name: itemForm.name.trim(),
          unit: itemForm.unit.trim() || 'piece',
          category: itemForm.category.trim() || null,
          unitCost: itemForm.unitCost === '' ? null : Number(itemForm.unitCost),
          reorderLevel: itemForm.reorderLevel === '' ? null : Number(itemForm.reorderLevel),
          notes: itemForm.notes.trim() || null,
        }),
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

  const lineTotal = lineForm.purchaseQuantity && lineForm.purchaseUnitCost
    ? Number(lineForm.purchaseQuantity) * Number(lineForm.purchaseUnitCost)
    : null
  // What the line will actually add to stock, shown while it is being typed so
  // a wrong pack size is caught before it is saved rather than after.
  const linePreview = lineForm.purchaseQuantity
    ? toStockUnits({
        purchaseQuantity: Number(lineForm.purchaseQuantity),
        purchaseUnitCost: lineForm.purchaseUnitCost === '' ? null : Number(lineForm.purchaseUnitCost),
        unitsPerPurchaseUnit: lineForm.unitsPerPurchaseUnit === '' ? 1 : Number(lineForm.unitsPerPurchaseUnit),
      })
    : null
  const showsPackConversion = Boolean(linePreview && linePreview.factor !== 1)

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Loading operating equipments…</div>
  }

  function renderDeliveryColumnLabels() {
    return (
      <tr className="bg-white border-b border-gray-200">
        {DELIVERY_COLUMN_LABELS.map((label, index) => (
          <th key={`${label}-${index}`} className="px-3 py-2 text-left text-xs font-semibold text-gray-600">{label}</th>
        ))}
      </tr>
    )
  }

  function renderDeliveryRow(move: Movement) {
    return (
      <tr key={move.id} className="hover:bg-gray-50/60">
        <td className="px-3 py-2 font-medium text-gray-900">{move.equipment?.name ?? '—'}</td>
        <td className="px-3 py-2 text-gray-500">{move.supplier || '—'}</td>
        <td className="px-3 py-2 text-gray-500">{move.purchaseUnit || move.equipment?.unit}</td>
        <td className="px-3 py-2 text-right text-gray-900">
          {fmtQty(move.purchaseQuantity ?? move.quantity)}
        </td>
        {/* The pack size, and what it worked out to. A line bought and counted
            in the same unit has nothing to explain, so it shows a dash. */}
        <td className="px-3 py-2 text-gray-500">
          {move.unitsPerPurchaseUnit && move.unitsPerPurchaseUnit !== 1
            ? `1 ${move.purchaseUnit} = ${fmtQty(move.unitsPerPurchaseUnit)} ${move.equipment?.unit}`
            : '—'}
        </td>
        <td className="px-3 py-2 text-gray-500">
          {fmtQty(move.quantity)} <span className="text-xs text-gray-400">{move.equipment?.unit}</span>
        </td>
        <td className="px-3 py-2 text-right text-gray-500">
          {move.purchaseUnitCost != null && move.purchaseUnitCost > 0
            ? fmt(move.purchaseUnitCost)
            : move.unitCost > 0 ? fmt(move.unitCost) : '—'}
        </td>
        <td className="px-3 py-2 text-right text-gray-700">{move.totalCost > 0 ? fmt(move.totalCost) : '—'}</td>
        <td className="px-3 py-2" />
      </tr>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-gray-900">Operating Equipments</h1>
          <BranchBadge />
        </div>
        {/* One way in, from either view. There is deliberately no "create item"
            button: an item comes into being by being named on a delivery line,
            exactly as stock does. A separate create step would let an item exist
            that nothing ever arrived for, and would ask the person recording a
            delivery to know which items the database has already seen. */}
        {!batchOpen && (
          <button type="button" onClick={openBatch}
            className="rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600">
            + Record new delivery
          </button>
        )}
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
              <p className="mt-1 text-xs text-gray-500">Record a delivery below — items are created as you type them.</p>
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
                    {(m.note || m.supplier || m.recordedBy || m.batchId) && (
                      <p className="text-xs text-gray-400 truncate">
                        {[m.batchId, m.supplier, m.note, m.recordedBy && `by ${m.recordedBy}`].filter(Boolean).join(' · ')}
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

      {/* Deliveries — the same table shape the stock screen uses, and the only
          way an item comes into existence here. */}
      <h2 className="text-sm font-bold text-gray-900 pt-2">Deliveries</h2>
      {(
        deliveryGroups.length === 0 && !batchOpen ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <Boxes className="h-8 w-8 text-gray-300 mx-auto" />
            <p className="mt-3 text-sm font-semibold text-gray-700">No deliveries recorded yet</p>
            <p className="text-sm text-gray-400 mt-1">Use + Record new delivery to add the orange batch row, choose a date, then type each line directly into the table.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto"><table className="w-full text-sm min-w-[1180px]">
              <tbody className="divide-y divide-gray-50">
                {batchOpen && (
                  <>
                    <tr className="bg-orange-400 border-y border-orange-700">
                      <td colSpan={DELIVERY_COLUMN_LABELS.length} className="px-3 py-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] font-semibold text-gray-900">
                            <span>BATCH_ID: {activeBatchId}</span>
                            <span>|</span>
                            <label className="flex items-center gap-2 font-medium">
                              <span>Date</span>
                              <input type="date" value={batchDate}
                                onChange={e => setBatchDate(e.target.value)}
                                disabled={activeBatchLines.length > 0}
                                className="rounded border border-orange-700 bg-white px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-orange-200 disabled:bg-orange-100 disabled:text-gray-500"/>
                            </label>
                            <span>|</span>
                            <span>{activeBatchLines.length} row{activeBatchLines.length === 1 ? '' : 's'}</span>
                            <button type="button" onClick={closeBatch} className="font-semibold text-gray-900 underline-offset-2 hover:underline">
                              Close batch
                            </button>
                          </div>
                          <button type="button" onClick={() => { setRecorderOpen(true); setLineForm(emptyLineForm()) }}
                            disabled={recorderOpen}
                            className="rounded-md border border-orange-200 bg-white px-3 py-1 text-xs font-semibold text-orange-600 transition-colors hover:bg-orange-50 disabled:opacity-50">
                            {recorderOpen ? 'Recording…' : '+ Add item'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {renderDeliveryColumnLabels()}
                    {recorderOpen && (
                      <>
                        <tr className="bg-emerald-50/80">
                          <td className="px-3 py-2 align-top">
                            {/* The ghost sits on top of a transparent input, so the
                                untyped tail of the suggested name reads as a
                                continuation of what was typed. Both boxes carry
                                identical text metrics. */}
                            <div className="relative rounded-md bg-white">
                              <input value={lineForm.itemName} onChange={e => handleLineNameChange(e.target.value)}
                                onKeyDown={handleLineNameKeyDown} autoComplete="off" autoFocus
                                className="relative z-10 w-full rounded-md border border-emerald-300 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-300"
                                placeholder="Item name"/>
                              {itemSuggestion?.remainder && (
                                <p aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre rounded-md border border-transparent px-3 py-2 text-sm text-gray-400">
                                  <span className="invisible">{lineForm.itemName}</span>{itemSuggestion.remainder}
                                </p>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <input value={lineForm.supplier} onChange={e => setLineForm(f => ({ ...f, supplier: e.target.value }))}
                              onKeyDown={handleLineKeyDown} placeholder="Supplier"
                              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-300"/>
                          </td>
                          {/* Bought in — what a delivery arrives as. */}
                          <td className="px-3 py-2 align-top">
                            <select value={lineForm.purchaseUnit} onChange={e => handlePurchaseUnitChange(e.target.value)}
                              onKeyDown={handleLineKeyDown}
                              className="w-full rounded-md border border-gray-200 bg-white px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-300">
                              {INVENTORY_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <input type="number" value={lineForm.purchaseQuantity}
                              onChange={e => setLineForm(f => ({ ...f, purchaseQuantity: e.target.value }))}
                              onKeyDown={handleLineKeyDown} placeholder="0"
                              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-right outline-none focus:ring-2 focus:ring-emerald-300"/>
                          </td>
                          {/* Pack size — "1 bottle = 500 ml". Left at 1 when a
                              thing is bought and counted the same way. */}
                          <td className="px-3 py-2 align-top">
                            <div className="flex items-center gap-1 whitespace-nowrap">
                              <span className="text-xs text-gray-500">1 {lineForm.purchaseUnit} =</span>
                              <input type="number" value={lineForm.unitsPerPurchaseUnit}
                                onChange={e => setLineForm(f => ({ ...f, unitsPerPurchaseUnit: e.target.value }))}
                                onKeyDown={handleLineKeyDown} placeholder="1"
                                className="w-20 rounded-md border border-gray-200 bg-white px-2 py-2 text-sm text-right outline-none focus:ring-2 focus:ring-emerald-300"/>
                            </div>
                          </td>
                          {/* Counted in — the unit stock is held and issued in. */}
                          <td className="px-3 py-2 align-top">
                            <select value={lineForm.unit} onChange={e => handleUsageUnitChange(e.target.value)}
                              onKeyDown={handleLineKeyDown}
                              className="w-full rounded-md border border-gray-200 bg-white px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-300">
                              {INVENTORY_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <input type="number" value={lineForm.purchaseUnitCost}
                              onChange={e => setLineForm(f => ({ ...f, purchaseUnitCost: e.target.value }))}
                              onKeyDown={handleLineKeyDown} placeholder="0"
                              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-right outline-none focus:ring-2 focus:ring-emerald-300"/>
                          </td>
                          <td className="px-3 py-2 align-top text-right text-sm font-semibold text-gray-700">
                            {lineTotal == null ? '—' : fmt(lineTotal)}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="flex items-center gap-1">
                              <button type="button" onClick={() => void saveLine()} disabled={saving || !lineForm.itemName.trim() || lineForm.purchaseQuantity === ''}
                                className="rounded-md bg-emerald-600 px-2.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                                {saving ? 'Saving…' : 'Save'}
                              </button>
                              <button type="button" onClick={closeRecorder}
                                className="rounded-md border border-gray-200 px-2 py-2 text-xs font-semibold text-gray-500 hover:bg-gray-50">
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                        <tr className="bg-emerald-50/60">
                          <td colSpan={DELIVERY_COLUMN_LABELS.length} className="px-3 pb-2 text-[11px] text-gray-600">
                            {itemSuggestion ? (<>
                              <span className="rounded border border-emerald-300 bg-white px-1.5 py-0.5 font-semibold">Space</span>
                              <span className="ml-2 mr-4 font-medium">Fill {itemSuggestion.itemName}</span>
                              <span className="rounded border border-emerald-300 bg-white px-1.5 py-0.5 font-semibold">Esc</span>
                              <span className="ml-2 mr-4">Ignore it</span>
                              <span className="rounded border border-emerald-300 bg-white px-1.5 py-0.5 font-semibold">Enter</span>
                              <span className="ml-2">Save and start the next line</span>
                            </>) : (<>
                              {/* What the pack size works out to, before it is
                                  saved — the moment a wrong factor is cheap to
                                  notice rather than expensive to unpick. */}
                              {showsPackConversion && linePreview && (
                                <span className="mr-4 font-semibold text-emerald-800">
                                  Adds {fmtQty(linePreview.quantity)} {lineForm.unit} to stock
                                  {linePreview.unitCost > 0 && ` at ${fmt(linePreview.unitCost)} per ${lineForm.unit}`}
                                </span>
                              )}
                              {autofillNotice && <span className="mr-4 font-medium">{autofillNotice}</span>}
                              <span className="rounded border border-emerald-300 bg-white px-1.5 py-0.5 font-semibold">Enter</span>
                              <span className="ml-2 mr-4">Save and start the next line</span>
                              <span className="rounded border border-emerald-300 bg-white px-1.5 py-0.5 font-semibold">Esc</span>
                              <span className="ml-2">Close recorder</span>
                            </>)}
                          </td>
                        </tr>
                      </>
                    )}
                    {activeBatchLines.map(renderDeliveryRow)}
                  </>
                )}
                {deliveryGroups.map(group => (
                  <Fragment key={group.key}>
                    <tr className="bg-orange-400 border-y border-orange-700">
                      <td colSpan={DELIVERY_COLUMN_LABELS.length} className="px-3 py-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] font-semibold text-gray-900">
                            <span>BATCH_ID: {group.batchId || 'NO BATCH ID'}</span>
                            <span>|</span>
                            <span>{formatBatchDateLabel(group.occurredAt)}</span>
                            <span>|</span>
                            <span>{group.lines.length} row{group.lines.length === 1 ? '' : 's'}</span>
                          </div>
                          <button type="button" onClick={() => openRecorderForBatch(group.batchId, group.occurredAt)}
                            disabled={!group.batchId || batchOpen}
                            className="rounded-md border border-orange-200 bg-white px-3 py-1 text-xs font-semibold text-orange-600 transition-colors hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-50">
                            + Add item
                          </button>
                        </div>
                      </td>
                    </tr>
                    {renderDeliveryColumnLabels()}
                    {group.lines.map(renderDeliveryRow)}
                  </Fragment>
                ))}
              </tbody>
            </table></div>
          </div>
        )
      )}

      {showItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-bold text-gray-900">Edit item</h2>
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
              <p className="text-xs text-gray-400">
                Quantity is not edited here — it only moves through a recorded delivery,
                issue or correction, so every number has a reason behind it.
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100">
              <button type="button" onClick={() => setShowItemModal(false)}
                className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={() => void saveItem()} disabled={saving || !itemForm.name.trim()}
                className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
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

'use client'
import { Fragment, useEffect, useState } from 'react'
import { AlertTriangle, X, Sparkles, ShoppingCart, Search, Trash2 } from 'lucide-react'
import { createInventoryBatchSuffix, formatInventoryBatchId } from '@/lib/inventoryBatch'
import {
  derivePurchaseQuantity,
  derivePurchaseUnitCost,
  DEFAULT_USAGE_UNIT_BY_PURCHASE_UNIT,
  getPurchaseUnit,
  getUnitsPerPurchaseUnit,
  INVENTORY_UNITS,
  isDualUnitPurchaseUnit,
  splitUsageQuantity,
} from '@/lib/inventoryUnits'

type Ingredient = {
  id: string
  name: string
  unit: string
  purchaseUnit: string | null
  unitsPerPurchaseUnit: number | null
  unitCost: number | null
  quantity: number
  reorderLevel: number
  category: string | null
}
type Purchase = {
  id: string
  batchId: string | null
  ingredientId: string
  supplier: string | null
  purchaseQuantity: number | null
  purchaseUnit: string | null
  unitsPerPurchaseUnit: number | null
  purchaseUnitCost: number | null
  quantityPurchased: number
  remainingQuantity: number
  unitCost: number
  totalCost: number
  purchasedAt: string
  createdAt: string
  ingredient: { name: string; unit: string; purchaseUnit: string | null; unitsPerPurchaseUnit: number | null }
}
type PurchaseBatchGroup = { key: string; batchId: string | null; purchasedAt: string; earliestCreatedAt: string; totalCost: number; purchases: Purchase[] }
const INVENTORY_COLUMN_LABELS = ['Item', 'Supplier', 'Unit', 'Opening stock', 'Cost/unit', 'Stock on hand', 'Tot. stock value', 'Actions'] as const
const FRESH_FETCH_OPTIONS = { credentials: 'include' as const, cache: 'no-store' as const }

const fmt = (n: number) => n.toLocaleString('en-RW', { maximumFractionDigits: 0 })
const fmtQty = (n: number) => n.toLocaleString('en-RW', { maximumFractionDigits: 2 })
const PURCHASE_USAGE_EPSILON = 0.000001
const normalizeInventoryItemName = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
const todayInputValue = () => {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}
const createEmptyPurchaseForm = (purchasedAt = todayInputValue()) => ({
  itemName: '',
  usageUnit: '',
  purchaseUnit: '',
  unitsPerPurchaseUnit: '',
  supplier: '',
  purchaseQuantity: '',
  purchaseUnitCost: '',
  purchasedAt,
})

function parseDateInput(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return new Date()
  return new Date(year, month - 1, day)
}

function formatDateInput(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return todayInputValue()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function formatBatchDateLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Invalid date'
  return date.toLocaleDateString('en-RW', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatBatchCreatedTimeLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return date.toLocaleTimeString('en-RW', { hour: '2-digit', minute: '2-digit' })
}

function formatUnitSummary(purchaseUnit: string, usageUnit: string, unitsPerPurchaseUnit: number) {
  if (purchaseUnit.toLowerCase() === usageUnit.toLowerCase() || unitsPerPurchaseUnit <= 1) return usageUnit
  return `${purchaseUnit} -> ${usageUnit}`
}

function formatStockOnHand(quantity: number, usageUnit: string, purchaseUnit: string, unitsPerPurchaseUnit: number) {
  if (purchaseUnit.toLowerCase() === usageUnit.toLowerCase() || unitsPerPurchaseUnit <= 1) {
    return `${fmtQty(quantity)} ${usageUnit}`
  }

  const breakdown = splitUsageQuantity(quantity, unitsPerPurchaseUnit)
  if (breakdown.wholePurchaseUnits > 0 && breakdown.remainderUsageQuantity > PURCHASE_USAGE_EPSILON) {
    return `${fmtQty(breakdown.wholePurchaseUnits)} ${purchaseUnit} + ${fmtQty(breakdown.remainderUsageQuantity)} ${usageUnit}`
  }
  if (breakdown.wholePurchaseUnits > 0) {
    return `${fmtQty(breakdown.wholePurchaseUnits)} ${purchaseUnit}`
  }
  return `${fmtQty(quantity)} ${usageUnit} (~${fmtQty(breakdown.approxPurchaseUnits)} ${purchaseUnit})`
}

function getPurchaseDisplayMeta(purchase: Purchase) {
  const purchaseUnit = getPurchaseUnit({
    unit: purchase.ingredient.unit,
    purchaseUnit: purchase.purchaseUnit ?? purchase.ingredient.purchaseUnit,
    unitsPerPurchaseUnit: purchase.unitsPerPurchaseUnit ?? purchase.ingredient.unitsPerPurchaseUnit,
  })
  const unitsPerPurchaseUnit = getUnitsPerPurchaseUnit({
    unit: purchase.ingredient.unit,
    purchaseUnit,
    unitsPerPurchaseUnit: purchase.unitsPerPurchaseUnit ?? purchase.ingredient.unitsPerPurchaseUnit,
  })
  const purchaseQuantity = derivePurchaseQuantity({
    unit: purchase.ingredient.unit,
    purchaseUnit,
    unitsPerPurchaseUnit,
    purchaseQuantity: purchase.purchaseQuantity,
    quantityPurchased: purchase.quantityPurchased,
  })
  const purchaseUnitCost = derivePurchaseUnitCost({
    unit: purchase.ingredient.unit,
    purchaseUnit,
    unitsPerPurchaseUnit,
    purchaseUnitCost: purchase.purchaseUnitCost,
    unitCost: purchase.unitCost,
  })

  return {
    purchaseUnit,
    usageUnit: purchase.ingredient.unit,
    unitsPerPurchaseUnit,
    purchaseQuantity,
    purchaseUnitCost,
  }
}

function extractBatchSuffix(batchId: string) {
  const match = /^B-\d{8}-(.+)$/.exec(batchId.trim())
  return match?.[1] ?? ''
}

function renderBatchColumnLabels() {
  return (
    <tr className="bg-white border-b border-gray-200">
      {INVENTORY_COLUMN_LABELS.map((label) => (
        <th key={label} className="px-4 py-2 text-left text-xs font-semibold text-gray-600">
          {label}
        </th>
      ))}
    </tr>
  )
}

function comparePurchaseRows(
  left: Pick<Purchase, 'purchasedAt' | 'createdAt' | 'id'>,
  right: Pick<Purchase, 'purchasedAt' | 'createdAt' | 'id'>,
) {
  return new Date(right.purchasedAt).getTime() - new Date(left.purchasedAt).getTime()
    || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    || right.id.localeCompare(left.id)
}

function compareBatchGroups(left: PurchaseBatchGroup, right: PurchaseBatchGroup) {
  return new Date(right.purchasedAt).getTime() - new Date(left.purchasedAt).getTime()
    || new Date(right.earliestCreatedAt).getTime() - new Date(left.earliestCreatedAt).getTime()
    || right.key.localeCompare(left.key)
}

function groupPurchasesByBatch(purchases: Purchase[]) {
  const groups = new Map<string, PurchaseBatchGroup>()

  for (const purchase of purchases) {
    const key = purchase.batchId || `purchase-${purchase.id}`
    const existingGroup = groups.get(key)

    if (existingGroup) {
      existingGroup.purchases.push(purchase)
      existingGroup.totalCost += purchase.totalCost

      if (new Date(purchase.createdAt).getTime() < new Date(existingGroup.earliestCreatedAt).getTime()) {
        existingGroup.earliestCreatedAt = purchase.createdAt
      }
      continue
    }

    groups.set(key, {
      key,
      batchId: purchase.batchId,
      purchasedAt: purchase.purchasedAt,
      earliestCreatedAt: purchase.createdAt,
      totalCost: purchase.totalCost,
      purchases: [purchase],
    })
  }

  return Array.from(groups.values())
    .map(group => ({
      ...group,
      purchases: group.purchases.slice().sort(comparePurchaseRows),
    }))
    .sort(compareBatchGroups)
}

export default function RestaurantInventory({ onAskJesse }: { onAskJesse?: () => void }) {
  const [items, setItems] = useState<Ingredient[]>([])
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [itemsLoading, setItemsLoading] = useState(true)
  const [purchasesLoading, setPurchasesLoading] = useState(true)
  const [showPurchaseForm, setShowPurchaseForm] = useState(false)
  const [showPurchaseRecorder, setShowPurchaseRecorder] = useState(false)
  const [activeBatchSuffix, setActiveBatchSuffix] = useState('')
  const [activeBatchDate, setActiveBatchDate] = useState(todayInputValue())
  const [editingPurchaseId, setEditingPurchaseId] = useState<string | null>(null)
  const [purchaseError, setPurchaseError] = useState<string | null>(null)
  const [purchaseAutofillNotice, setPurchaseAutofillNotice] = useState<string | null>(null)
  const [purchaseAutofillMatchKey, setPurchaseAutofillMatchKey] = useState('')
  const [pForm, setPForm] = useState(createEmptyPurchaseForm())
  const [pSaving, setPSaving] = useState(false)

  async function load() {
    setItemsLoading(true)
    const data = await fetch('/api/restaurant/ingredients', FRESH_FETCH_OPTIONS).then(r=>r.json())
    setItems(Array.isArray(data)?data:[])
    setItemsLoading(false)
  }

  async function loadPurchases() {
    setPurchasesLoading(true)
    const data = await fetch('/api/restaurant/inventory-purchases', FRESH_FETCH_OPTIONS).then(r=>r.json())
    setPurchases(Array.isArray(data)?data:[])
    setPurchasesLoading(false)
  }

  useEffect(() => {
    void load()
    void loadPurchases()
  }, [])

  function resolvePurchaseFormUnits() {
    const purchaseUnit = pForm.purchaseUnit.trim()
    const usageUnit = (pForm.usageUnit.trim() || purchaseUnit).trim()
    const sameUnit = purchaseUnit.toLowerCase() === usageUnit.toLowerCase()
    const unitsPerPurchaseUnit = sameUnit ? 1 : Number(pForm.unitsPerPurchaseUnit)
    return { purchaseUnit, usageUnit, unitsPerPurchaseUnit, sameUnit }
  }

  function updatePurchaseUnit(nextPurchaseUnit: string) {
    setPForm((current) => {
      if (isDualUnitPurchaseUnit(nextPurchaseUnit)) {
        const defaultUsage = DEFAULT_USAGE_UNIT_BY_PURCHASE_UNIT[nextPurchaseUnit.toLowerCase()] || ''
        const shouldFollowPurchaseUnit = !current.usageUnit || current.usageUnit.toLowerCase() === current.purchaseUnit.toLowerCase()
        const nextUsageUnit = shouldFollowPurchaseUnit ? defaultUsage : current.usageUnit
        const sameUnit = nextPurchaseUnit.toLowerCase() === nextUsageUnit.toLowerCase()
        return {
          ...current,
          purchaseUnit: nextPurchaseUnit,
          usageUnit: nextUsageUnit,
          unitsPerPurchaseUnit: sameUnit ? '' : current.unitsPerPurchaseUnit,
        }
      }
      return {
        ...current,
        purchaseUnit: nextPurchaseUnit,
        usageUnit: '',
        unitsPerPurchaseUnit: '',
      }
    })
  }

  function updateUsageUnit(nextUsageUnit: string) {
    setPForm((current) => {
      const sameUnit = nextUsageUnit.toLowerCase() === current.purchaseUnit.toLowerCase()
      return {
        ...current,
        usageUnit: nextUsageUnit,
        unitsPerPurchaseUnit: sameUnit ? '' : current.unitsPerPurchaseUnit,
      }
    })
  }

  function findPurchaseAutofillPreset(itemName: string) {
    const normalizedItemName = normalizeInventoryItemName(itemName)
    if (!normalizedItemName) return null

    const latestPurchase = purchases
      .filter((purchase) => normalizeInventoryItemName(purchase.ingredient.name) === normalizedItemName)
      .slice()
      .sort(comparePurchaseRows)[0]

    if (latestPurchase) {
      const purchaseMeta = getPurchaseDisplayMeta(latestPurchase)
      const hasKnownPurchaseCost = latestPurchase.purchaseUnitCost != null || latestPurchase.unitCost != null
      return {
        supplier: latestPurchase.supplier || '',
        usageUnit: purchaseMeta.usageUnit,
        purchaseUnit: purchaseMeta.purchaseUnit,
        unitsPerPurchaseUnit: purchaseMeta.purchaseUnit.toLowerCase() === purchaseMeta.usageUnit.toLowerCase()
          ? ''
          : String(purchaseMeta.unitsPerPurchaseUnit),
        purchaseUnitCost: hasKnownPurchaseCost ? String(purchaseMeta.purchaseUnitCost) : '',
        notice: `Autofilled from the latest ${latestPurchase.ingredient.name} record. Keep it or edit any field before saving.`,
      }
    }

    const matchedItem = items.find((item) => normalizeInventoryItemName(item.name) === normalizedItemName)
    if (!matchedItem) return null

    const purchaseUnit = getPurchaseUnit(matchedItem)
    const unitsPerPurchaseUnit = getUnitsPerPurchaseUnit(matchedItem)
    const hasKnownCost = matchedItem.unitCost != null
    const purchaseUnitCost = hasKnownCost
      ? derivePurchaseUnitCost({
          unit: matchedItem.unit,
          purchaseUnit,
          unitsPerPurchaseUnit,
          unitCost: matchedItem.unitCost,
        })
      : null

    return {
      supplier: '',
      usageUnit: matchedItem.unit,
      purchaseUnit,
      unitsPerPurchaseUnit: purchaseUnit.toLowerCase() === matchedItem.unit.toLowerCase()
        ? ''
        : String(unitsPerPurchaseUnit),
      purchaseUnitCost: purchaseUnitCost == null ? '' : String(purchaseUnitCost),
      notice: `Autofilled from saved ${matchedItem.name} settings. Keep it or edit any field before saving.`,
    }
  }

  function handlePurchaseItemNameChange(nextItemName: string) {
    const normalizedItemName = normalizeInventoryItemName(nextItemName)
    const autofillPreset = !editingPurchaseId && showPurchaseRecorder
      ? findPurchaseAutofillPreset(nextItemName)
      : null
    const shouldApplyAutofill = Boolean(autofillPreset && normalizedItemName && purchaseAutofillMatchKey !== normalizedItemName)

    setPForm((current) => ({
      ...current,
      itemName: nextItemName,
      supplier: shouldApplyAutofill ? autofillPreset!.supplier : current.supplier,
      usageUnit: shouldApplyAutofill ? autofillPreset!.usageUnit : current.usageUnit,
      purchaseUnit: shouldApplyAutofill ? autofillPreset!.purchaseUnit : current.purchaseUnit,
      unitsPerPurchaseUnit: shouldApplyAutofill ? autofillPreset!.unitsPerPurchaseUnit : current.unitsPerPurchaseUnit,
      purchaseUnitCost: shouldApplyAutofill ? autofillPreset!.purchaseUnitCost : current.purchaseUnitCost,
    }))

    if (shouldApplyAutofill) {
      setPurchaseAutofillMatchKey(normalizedItemName)
      setPurchaseAutofillNotice(autofillPreset!.notice)
      return
    }

    if (!autofillPreset || !normalizedItemName) {
      setPurchaseAutofillMatchKey('')
      setPurchaseAutofillNotice(null)
    }
  }

  function closePurchaseForm() {
    setShowPurchaseForm(false)
    setShowPurchaseRecorder(false)
    setActiveBatchSuffix('')
    setActiveBatchDate(todayInputValue())
    setEditingPurchaseId(null)
    setPurchaseError(null)
    setPurchaseAutofillNotice(null)
    setPurchaseAutofillMatchKey('')
    setPForm(createEmptyPurchaseForm())
  }

  function cancelPurchaseEdit() {
    setEditingPurchaseId(null)
    setPurchaseError(null)
    setPurchaseAutofillNotice(null)
    setPurchaseAutofillMatchKey('')
    setPForm(createEmptyPurchaseForm(activeBatchDate))
  }

  function openNewPurchaseRow() {
    const nextBatchDate = todayInputValue()
    setEditingPurchaseId(null)
    setPurSearch('')
    setPurchaseError(null)
    setPurchaseAutofillNotice(null)
    setPurchaseAutofillMatchKey('')
    setActiveBatchSuffix(createInventoryBatchSuffix())
    setActiveBatchDate(nextBatchDate)
    setPForm(createEmptyPurchaseForm(nextBatchDate))
    setShowPurchaseForm(true)
    setShowPurchaseRecorder(true)
  }

  function openBatchForNewItem(batchId: string | null, purchasedAt: string) {
    if (!batchId || pSaving) return

    const batchSuffix = extractBatchSuffix(batchId)
    if (!batchSuffix) return

    const batchDate = formatDateInput(purchasedAt)
    setEditingPurchaseId(null)
    setPurSearch('')
    setPurchaseError(null)
    setPurchaseAutofillNotice(null)
    setPurchaseAutofillMatchKey('')
    setActiveBatchSuffix(batchSuffix)
    setActiveBatchDate(batchDate)
    setPForm(createEmptyPurchaseForm(batchDate))
    setShowPurchaseForm(true)
    setShowPurchaseRecorder(true)
  }

  function openEditPurchase(purchase: Purchase) {
    const purchaseMeta = getPurchaseDisplayMeta(purchase)
    setShowPurchaseForm(false)
    setActiveBatchSuffix('')
    setActiveBatchDate(formatDateInput(purchase.purchasedAt))
    setPurSearch('')
    setPurchaseError(null)
    setPurchaseAutofillNotice(null)
    setPurchaseAutofillMatchKey('')
    setEditingPurchaseId(purchase.id)
    setPForm({
      itemName: purchase.ingredient.name,
      usageUnit: purchaseMeta.usageUnit,
      purchaseUnit: purchaseMeta.purchaseUnit,
      unitsPerPurchaseUnit: purchaseMeta.unitsPerPurchaseUnit === 1 ? '' : String(purchaseMeta.unitsPerPurchaseUnit),
      supplier: purchase.supplier || '',
      purchaseQuantity: String(purchaseMeta.purchaseQuantity),
      purchaseUnitCost: String(purchaseMeta.purchaseUnitCost),
      purchasedAt: formatDateInput(purchase.purchasedAt),
    })
  }

  async function savePurchase(e?: React.FormEvent) {
    e?.preventDefault()
    const unitConfig = resolvePurchaseFormUnits()
    if (!pForm.itemName || !unitConfig.purchaseUnit || !unitConfig.usageUnit || !pForm.purchaseQuantity || !pForm.purchaseUnitCost) return
    if (!unitConfig.sameUnit && (!Number.isFinite(unitConfig.unitsPerPurchaseUnit) || unitConfig.unitsPerPurchaseUnit <= 0)) {
      setPurchaseError('Enter how many usage units exist in one purchase unit.')
      return
    }

    const batchId = activeBatchSuffix ? formatInventoryBatchId(parseDateInput(activeBatchDate), activeBatchSuffix) : ''
    if (!batchId) return

    setPSaving(true)
    setPurchaseError(null)
    try {
      const res = await fetch('/api/restaurant/inventory-purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batchId,
          itemName: pForm.itemName,
          unit: unitConfig.usageUnit,
          purchaseUnit: unitConfig.purchaseUnit,
          unitsPerPurchaseUnit: unitConfig.sameUnit ? 1 : unitConfig.unitsPerPurchaseUnit,
          supplier: pForm.supplier || null,
          purchaseQuantity: Number(pForm.purchaseQuantity),
          purchaseUnitCost: Number(pForm.purchaseUnitCost),
          purchasedAt: activeBatchDate,
        })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setPurchaseError(err?.error || 'Save failed')
        return
      }
      await Promise.all([load(), loadPurchases()])
      setShowPurchaseRecorder(false)
      setPurchaseAutofillNotice(null)
      setPurchaseAutofillMatchKey('')
      setPForm(createEmptyPurchaseForm(activeBatchDate))
    } finally {
      setPSaving(false)
    }
  }

  async function updatePurchase(e?: React.FormEvent) {
    e?.preventDefault()
    const unitConfig = resolvePurchaseFormUnits()
    if (!editingPurchaseId || !pForm.itemName || !unitConfig.purchaseUnit || !unitConfig.usageUnit || !pForm.purchaseQuantity || !pForm.purchaseUnitCost) return
    if (!unitConfig.sameUnit && (!Number.isFinite(unitConfig.unitsPerPurchaseUnit) || unitConfig.unitsPerPurchaseUnit <= 0)) {
      setPurchaseError('Enter how many usage units exist in one purchase unit.')
      return
    }
    setPSaving(true)
    setPurchaseError(null)
    try {
      const res = await fetch('/api/restaurant/inventory-purchases', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingPurchaseId,
          itemName: pForm.itemName,
          unit: unitConfig.usageUnit,
          purchaseUnit: unitConfig.purchaseUnit,
          unitsPerPurchaseUnit: unitConfig.sameUnit ? 1 : unitConfig.unitsPerPurchaseUnit,
          supplier: pForm.supplier || null,
          purchaseQuantity: Number(pForm.purchaseQuantity),
          purchaseUnitCost: Number(pForm.purchaseUnitCost),
          purchasedAt: pForm.purchasedAt,
        })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setPurchaseError(err?.error || 'Update failed')
        return
      }
      cancelPurchaseEdit()
      await Promise.all([load(), loadPurchases()])
    } finally {
      setPSaving(false)
    }
  }

  async function deletePurchase(purchase: Purchase) {
    const confirmed = window.confirm(`Delete stock entry for ${purchase.ingredient.name}?`)
    if (!confirmed) return

    setPSaving(true)
    setPurchaseError(null)
    try {
      const res = await fetch(`/api/restaurant/inventory-purchases?id=${encodeURIComponent(purchase.id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setPurchaseError(err?.error || 'Delete failed')
        return
      }
      if (editingPurchaseId === purchase.id) closePurchaseForm()
      await Promise.all([load(), loadPurchases()])
    } finally {
      setPSaving(false)
    }
  }

  function closePurchaseRecorder() {
  if (editingPurchaseId) {
    cancelPurchaseEdit()
    return
  }

  setPurchaseError(null)
  setPForm(createEmptyPurchaseForm(activeBatchDate))
  if (activeBatchPurchases.length === 0) {
    closePurchaseForm()
    return
  }
  setShowPurchaseRecorder(false)
  }

  function handlePurchaseRowKeyDown(event: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (editingPurchaseId) void updatePurchase()
      else void savePurchase()
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      closePurchaseRecorder()
    }
  }

  const [purSearch, setPurSearch] = useState('')

  const lowStock = items.filter(i=>i.quantity<=i.reorderLevel)
  const totalValue = items.reduce((s,i)=>s+i.quantity*(i.unitCost??0),0)
  const totalPurchaseCost = purchases.reduce((s,p)=>s+p.totalCost,0)
  const ingredientLayerTotals = purchases.reduce((map, purchase) => {
    map.set(purchase.ingredientId, (map.get(purchase.ingredientId) ?? 0) + purchase.remainingQuantity)
    return map
  }, new Map<string, number>())
  const ingredientsWithLayerDrift = new Set(
    items
      .filter(item => Math.abs((ingredientLayerTotals.get(item.id) ?? 0) - item.quantity) > PURCHASE_USAGE_EPSILON)
      .map(item => item.id)
  )
  const searchQuery = purSearch.trim().toLowerCase()
  const matchesPurchaseSearch = (purchase: Purchase) => {
    const purchaseMeta = getPurchaseDisplayMeta(purchase)
    return !searchQuery
      || purchase.ingredient.name.toLowerCase().includes(searchQuery)
      || purchase.ingredient.unit.toLowerCase().includes(searchQuery)
      || purchaseMeta.purchaseUnit.toLowerCase().includes(searchQuery)
      || (purchase.supplier??'').toLowerCase().includes(searchQuery)
      || (purchase.batchId??'').toLowerCase().includes(searchQuery)
  }
  const canMutatePurchase = (purchase: Purchase) => {
    if (ingredientsWithLayerDrift.has(purchase.ingredientId)) return false
    return purchase.quantityPurchased - purchase.remainingQuantity <= PURCHASE_USAGE_EPSILON
  }
  const activeBatchId = showPurchaseForm && activeBatchSuffix ? formatInventoryBatchId(parseDateInput(activeBatchDate), activeBatchSuffix) : ''
  const activeBatchPurchases = activeBatchId
    ? purchases
        .filter(purchase => purchase.batchId === activeBatchId)
        .slice()
        .sort(comparePurchaseRows)
    : []
  const getIngredientStockDisplay = (item: Ingredient) => {
    const openPurchases = purchases.filter(purchase => purchase.ingredientId === item.id && purchase.remainingQuantity > PURCHASE_USAGE_EPSILON)
    if (openPurchases.length === 0) {
      const purchaseUnit = getPurchaseUnit(item)
      const unitsPerPurchaseUnit = getUnitsPerPurchaseUnit(item)
      return formatStockOnHand(Number(item.quantity || 0), item.unit, purchaseUnit, unitsPerPurchaseUnit)
    }

    const firstMeta = getPurchaseDisplayMeta(openPurchases[0])
    const hasMixedPackSizes = openPurchases.some((purchase) => {
      const meta = getPurchaseDisplayMeta(purchase)
      return meta.usageUnit.toLowerCase() !== firstMeta.usageUnit.toLowerCase()
        || meta.purchaseUnit.toLowerCase() !== firstMeta.purchaseUnit.toLowerCase()
        || Math.abs(meta.unitsPerPurchaseUnit - firstMeta.unitsPerPurchaseUnit) > PURCHASE_USAGE_EPSILON
    })

    if (hasMixedPackSizes) {
      return `${fmtQty(Number(item.quantity || 0))} ${item.unit} (mixed pack sizes)`
    }

    return formatStockOnHand(Number(item.quantity || 0), firstMeta.usageUnit, firstMeta.purchaseUnit, firstMeta.unitsPerPurchaseUnit)
  }
  const filteredPurchaseCount = purchases.filter(matchesPurchaseSearch).length
  const purchaseGroups = groupPurchasesByBatch(
    purchases.filter(purchase => purchase.batchId !== activeBatchId && matchesPurchaseSearch(purchase))
  )
  const batchCount = new Set(purchases.map(purchase => purchase.batchId || purchase.id)).size + (showPurchaseForm && activeBatchPurchases.length === 0 ? 1 : 0)
  const estimatedTotal = pForm.purchaseQuantity && pForm.purchaseUnitCost
    ? Number(pForm.purchaseQuantity) * Number(pForm.purchaseUnitCost) : null
  const knownItemNames = Array.from(new Set([
    ...items.map(item => item.name.trim()).filter(Boolean),
    ...purchases.map(purchase => purchase.ingredient.name.trim()).filter(Boolean),
  ])).sort((left, right) => left.localeCompare(right))
  const purchaseUnitOptions = pForm.purchaseUnit && !INVENTORY_UNITS.some(option => option.value === pForm.purchaseUnit)
    ? [{ value: pForm.purchaseUnit, label: pForm.purchaseUnit }, ...INVENTORY_UNITS]
    : INVENTORY_UNITS
  const usageUnitOptions = pForm.usageUnit && !INVENTORY_UNITS.some(option => option.value === pForm.usageUnit)
    ? [{ value: pForm.usageUnit, label: pForm.usageUnit }, ...INVENTORY_UNITS]
    : INVENTORY_UNITS

  function renderPurchaseRow(purchase: Purchase) {
    const purchaseLocked = !canMutatePurchase(purchase)
    const hasLayerDrift = ingredientsWithLayerDrift.has(purchase.ingredientId)
    const purchaseMeta = getPurchaseDisplayMeta(purchase)
    const displayedStockQuantity = purchase.remainingQuantity
    const displayedStockValue = displayedStockQuantity * purchase.unitCost
    const purchaseLockReason = hasLayerDrift
      ? 'This stock row is locked because stock has already moved on this ingredient.'
      : 'This stock entry has already been used by orders and cannot be edited.'

    if (editingPurchaseId === purchase.id) {
      return (
        <Fragment key={purchase.id}>
          <tr className="bg-amber-50/80">
            <td className="px-3 py-2 align-top">
              <input value={pForm.itemName} onChange={e=>setPForm(f=>({...f,itemName:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown}
                className="w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-300"
                placeholder="Item name"/>
            </td>
            <td className="px-3 py-2 align-top">
              <input value={pForm.supplier} onChange={e=>setPForm(f=>({...f,supplier:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown}
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-300"
                placeholder="Supplier (optional)"/>
            </td>
            <td className="px-3 py-2 align-top">
              <div className="space-y-2">
                <select value={pForm.purchaseUnit} onChange={e=>updatePurchaseUnit(e.target.value)} onKeyDown={handlePurchaseRowKeyDown}
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-300">
                  <option value="">Buy in…</option>
                  {purchaseUnitOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                {isDualUnitPurchaseUnit(pForm.purchaseUnit) && (<>
                <select value={pForm.usageUnit} onChange={e=>updateUsageUnit(e.target.value)} onKeyDown={handlePurchaseRowKeyDown}
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-300">
                  <option value="">Use in…</option>
                  {usageUnitOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                {pForm.purchaseUnit && pForm.usageUnit && pForm.purchaseUnit.toLowerCase() !== pForm.usageUnit.toLowerCase() && (
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span>1 {pForm.purchaseUnit} =</span>
                    <input required type="number" min="0.001" step="any" value={pForm.unitsPerPurchaseUnit} onChange={e=>setPForm(f=>({...f,unitsPerPurchaseUnit:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown}
                      className="w-20 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-amber-300"
                      placeholder="300"/>
                    <span>{pForm.usageUnit}</span>
                  </div>
                )}
                </>)}
              </div>
            </td>
            <td className="px-3 py-2 align-top">
              <input required type="number" min="0.001" step="any" value={pForm.purchaseQuantity} onChange={e=>setPForm(f=>({...f,purchaseQuantity:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown}
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-300"
                placeholder="Qty bought"/>
            </td>
            <td className="px-3 py-2 align-top">
              <input required type="number" min="0" step="any" value={pForm.purchaseUnitCost} onChange={e=>setPForm(f=>({...f,purchaseUnitCost:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown}
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-300"
                placeholder="Cost per bought unit"/>
            </td>
            <td className="px-4 py-2 text-sm text-gray-500">Auto</td>
            <td className="px-4 py-2 text-sm font-semibold text-gray-800">{estimatedTotal!=null?`${fmt(estimatedTotal)} RWF`:'auto'}</td>
            <td className="px-4 py-2">
              <div className="flex items-center gap-2">
                <button type="button" onClick={()=>void updatePurchase()} disabled={pSaving} className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50">Done</button>
                <button type="button" onClick={cancelPurchaseEdit} disabled={pSaving} className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50">Cancel</button>
              </div>
            </td>
          </tr>
          <tr className="bg-amber-50/80">
            <td colSpan={8} className="px-4 py-2 text-xs text-amber-800">
              <span className="rounded border border-amber-300 bg-white px-1.5 py-0.5 font-semibold">Enter</span>
              <span className="ml-2 mr-4">Update row</span>
              <span className="rounded border border-amber-300 bg-white px-1.5 py-0.5 font-semibold">Esc</span>
              <span className="ml-2">Cancel</span>
            </td>
          </tr>
        </Fragment>
      )
    }

    return (
      <tr key={purchase.id} className="hover:bg-gray-50 transition-colors">
        <td className="px-4 py-3 font-medium text-gray-900">{purchase.ingredient.name}</td>
        <td className="px-4 py-3 text-gray-500">{purchase.supplier||'—'}</td>
        <td className="px-4 py-3 text-gray-700">
          <p>{formatUnitSummary(purchaseMeta.purchaseUnit, purchaseMeta.usageUnit, purchaseMeta.unitsPerPurchaseUnit)}</p>
          {purchaseMeta.purchaseUnit.toLowerCase() !== purchaseMeta.usageUnit.toLowerCase() && (
            <p className="text-xs text-gray-400">1 {purchaseMeta.purchaseUnit} = {fmtQty(purchaseMeta.unitsPerPurchaseUnit)} {purchaseMeta.usageUnit}</p>
          )}
        </td>
        <td className="px-4 py-3 text-gray-700">{fmtQty(purchaseMeta.purchaseQuantity)} {purchaseMeta.purchaseUnit}</td>
        <td className="px-4 py-3 text-gray-700">
          <p>{fmt(purchaseMeta.purchaseUnitCost)} RWF</p>
          <p className="text-xs text-gray-400">per {purchaseMeta.purchaseUnit}</p>
        </td>
        <td className="px-4 py-3">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${displayedStockQuantity<=0?'bg-gray-100 text-gray-400':'bg-green-100 text-green-700'}`}>
            {formatStockOnHand(displayedStockQuantity, purchaseMeta.usageUnit, purchaseMeta.purchaseUnit, purchaseMeta.unitsPerPurchaseUnit)}
          </span>
        </td>
        <td className="px-4 py-3 font-semibold text-gray-900">{fmt(displayedStockValue)} RWF</td>
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={()=>void deletePurchase(purchase)}
            disabled={purchaseLocked || pSaving}
            title={purchaseLocked ? purchaseLockReason : 'Delete stock row'}
            className={purchaseLocked || pSaving
              ? 'rounded-md border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-300 cursor-not-allowed'
              : 'rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100'}
          >
            Delete
          </button>
        </td>
      </tr>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-800">Inventory</h2>
        <div className="flex items-center gap-2">
          <button onClick={onAskJesse} className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-orange-300 text-orange-600 bg-white hover:bg-orange-50 transition-colors">
            <Sparkles className="h-3.5 w-3.5"/> Ask Jesse
          </button>
          <button onClick={openNewPurchaseRow} className="bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
            + Record new Batch
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500">Total Items</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{items.length}</p>
        </div>
        <div className={`bg-white rounded-xl border p-4 shadow-sm text-center ${lowStock.length>0?'border-red-200':'border-gray-200'}`}>
          <p className="text-xs text-gray-500">Low Stock Alerts</p>
          <p className={`text-2xl font-bold mt-1 ${lowStock.length>0?'text-red-600':'text-gray-900'}`}>{lowStock.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500">Total Stock Value</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{fmt(totalValue)} RWF</p>
        </div>
      </div>

      {lowStock.length>0&&(
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0"/>
          <div className="text-sm text-red-700">
            <span className="font-semibold">Low stock: </span>
            {lowStock.map(i=>`${i.name} (${getIngredientStockDisplay(i)})`).join(', ')}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-600 shadow-sm">
        {batchCount} batch{batchCount===1?'':'es'} • {purchases.length} inventory row{purchases.length===1?'':'s'} • {fmt(totalPurchaseCost)} RWF recorded
      </div>

      {!purchasesLoading && (purchases.length>0 || showPurchaseForm) && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none"/>
          <input value={purSearch} onChange={e=>setPurSearch(e.target.value)}
            placeholder="Search batch ID, item or supplier…"
            className="w-full pl-7 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-orange-400 bg-gray-50"/>
        </div>
      )}

      {knownItemNames.length > 0 && (
        <datalist id="inventory-known-items">
          {knownItemNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}

      {purchaseError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
          {purchaseError}
        </div>
      )}

      {purchasesLoading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">Loading...</div>
      ) : purchases.length===0 && !showPurchaseForm ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <ShoppingCart className="h-10 w-10 text-gray-300 mx-auto mb-3"/>
          <p className="font-medium text-gray-600">No inventory recorded yet</p>
          <p className="text-sm text-gray-400 mt-1">Use + Record new Batch to add the orange batch row, choose a date, then type each inventory line directly into the table.</p>
        </div>
      ) : filteredPurchaseCount===0 && !showPurchaseForm ? (
        <div className="bg-white rounded-xl border border-gray-200 p-6 text-center text-sm text-gray-400">No inventory rows match your search.</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          {purSearch && <p className="px-4 py-2 text-xs text-gray-400 border-b border-gray-100">Showing {filteredPurchaseCount} of {purchases.length} inventory rows</p>}
          <div className="overflow-x-auto"><table className="w-full text-sm min-w-[920px]">
            <tbody className="divide-y divide-gray-50">
              {showPurchaseForm && (
                <>
                  <tr className="bg-orange-400 border-y border-orange-700">
                    <td colSpan={8} className="px-3 py-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] font-semibold text-gray-900">
                          <span>BATCH_ID: {activeBatchId}</span>
                          <span>|</span>
                          <label className="flex items-center gap-2 font-medium">
                            <span>Date</span>
                            <input
                              type="date"
                              value={activeBatchDate}
                              onChange={e=>{
                                setActiveBatchDate(e.target.value)
                                setPForm(f=>({...f,purchasedAt:e.target.value}))
                              }}
                              disabled={activeBatchPurchases.length>0 || pSaving}
                              className="rounded border border-orange-700 bg-white px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-orange-200 disabled:bg-orange-100 disabled:text-gray-500"
                            />
                          </label>
                          <span>|</span>
                          <span>{activeBatchPurchases.length} row{activeBatchPurchases.length===1?'':'s'}</span>
                          <button type="button" onClick={closePurchaseForm} disabled={pSaving} className="font-semibold text-gray-900 underline-offset-2 hover:underline disabled:opacity-50">
                            Close batch
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => openBatchForNewItem(activeBatchId || null, activeBatchDate)}
                          disabled={showPurchaseRecorder || pSaving}
                          className="rounded-md border border-orange-200 bg-white px-3 py-1 text-xs font-semibold text-orange-600 transition-colors hover:bg-orange-50 disabled:opacity-50"
                        >
                          {showPurchaseRecorder ? 'Recording…' : '+ Add item'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {renderBatchColumnLabels()}
                  {showPurchaseRecorder && (
                    <>
                  <tr className="bg-emerald-50/80">
                    <td className="px-3 py-2 align-top">
                      <input value={pForm.itemName} onChange={e=>handlePurchaseItemNameChange(e.target.value)} onKeyDown={handlePurchaseRowKeyDown} list="inventory-known-items"
                        className="w-full rounded-md border border-emerald-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-300"
                        placeholder="Item name"/>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input value={pForm.supplier} onChange={e=>setPForm(f=>({...f,supplier:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown}
                        className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-300"
                        placeholder="Supplier (optional)"/>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="space-y-2">
                        <select value={pForm.purchaseUnit} onChange={e=>updatePurchaseUnit(e.target.value)} onKeyDown={handlePurchaseRowKeyDown}
                          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-300">
                          <option value="">Buy in…</option>
                          {purchaseUnitOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                        {isDualUnitPurchaseUnit(pForm.purchaseUnit) && (<>
                        <select value={pForm.usageUnit} onChange={e=>updateUsageUnit(e.target.value)} onKeyDown={handlePurchaseRowKeyDown}
                          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-300">
                          <option value="">Use in…</option>
                          {usageUnitOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                        {pForm.purchaseUnit && pForm.usageUnit && pForm.purchaseUnit.toLowerCase() !== pForm.usageUnit.toLowerCase() && (
                          <div className="flex items-center gap-2 text-xs text-gray-500">
                            <span>1 {pForm.purchaseUnit} =</span>
                            <input required type="number" min="0.001" step="any" value={pForm.unitsPerPurchaseUnit} onChange={e=>setPForm(f=>({...f,unitsPerPurchaseUnit:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown}
                              className="w-20 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-emerald-300"
                              placeholder="300"/>
                            <span>{pForm.usageUnit}</span>
                          </div>
                        )}
                        </>)}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input required type="number" min="0.001" step="any" value={pForm.purchaseQuantity} onChange={e=>setPForm(f=>({...f,purchaseQuantity:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown}
                        className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-300"
                        placeholder="Qty bought"/>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input required type="number" min="0" step="any" value={pForm.purchaseUnitCost} onChange={e=>setPForm(f=>({...f,purchaseUnitCost:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown}
                        className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-300"
                        placeholder="Cost per bought unit"/>
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-500">Auto</td>
                    <td className="px-4 py-2 text-sm font-semibold text-gray-800">{estimatedTotal!=null?`${fmt(estimatedTotal)} RWF`:'auto'}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={()=>void savePurchase()} disabled={pSaving} className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50">Done</button>
                        <button type="button" onClick={closePurchaseRecorder} disabled={pSaving} className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50">Cancel</button>
                      </div>
                    </td>
                  </tr>
                  <tr className="bg-emerald-50/80">
                    <td colSpan={8} className="px-4 py-2 text-xs text-emerald-800">
                      {purchaseAutofillNotice && <span className="mr-4 font-medium">{purchaseAutofillNotice}</span>}
                      <span className="rounded border border-emerald-300 bg-white px-1.5 py-0.5 font-semibold">Enter</span>
                      <span className="ml-2 mr-4">Done and close recorder</span>
                      <span className="rounded border border-emerald-300 bg-white px-1.5 py-0.5 font-semibold">Esc</span>
                      <span className="ml-2">Cancel recorder</span>
                    </td>
                  </tr>
                    </>
                  )}
                  {activeBatchPurchases.map(renderPurchaseRow)}
                </>
              )}
              {purchaseGroups.map(group => (
                <Fragment key={group.key}>
                  <tr className="bg-orange-400 border-y border-orange-700">
                    <td colSpan={8} className="px-3 py-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] font-semibold text-gray-900">
                          <span>BATCH_ID: {group.batchId || 'NO BATCH ID'}</span>
                          <span>|</span>
                          <span>{formatBatchDateLabel(group.purchasedAt)}</span>
                          <span>|</span>
                          <span>Created {formatBatchCreatedTimeLabel(group.earliestCreatedAt)}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => openBatchForNewItem(group.batchId, group.purchasedAt)}
                          disabled={!group.batchId || pSaving}
                          className="rounded-md border border-orange-200 bg-white px-3 py-1 text-xs font-semibold text-orange-600 transition-colors hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          + Add item
                        </button>
                      </div>
                    </td>
                  </tr>
                  {renderBatchColumnLabels()}
                  {group.purchases.map(renderPurchaseRow)}
                </Fragment>
              ))}
            </tbody>
          </table></div>
        </div>
      )}

    </div>
  )
}



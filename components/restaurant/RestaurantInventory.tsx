'use client'
import { Fragment, useEffect, useState } from 'react'
import { useRestaurantBranch, BranchBadge } from '@/contexts/RestaurantBranchContext'
import { X, Sparkles, ShoppingCart, Search, Trash2 } from 'lucide-react'
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
  toUsageQuantity,
  toUsageUnitCost,
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
  type: string | null
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
type PrepRecipeRow = { id: string; prepItemId: string; ingredientItemId: string; quantityRequired: number; ingredient: { id: string; name: string; unit: string } }
const INVENTORY_COLUMN_LABELS = ['Item', 'Supplier', 'Unit', 'Qty bought', 'Cost/unit', 'Stock on hand', 'Tot. stock value', 'Actions'] as const
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
const PURCHASE_PAYMENT_OPTIONS = ['Cash', 'Mobile Money', 'Bank Transfer', 'Cheque', 'Credit'] as const

const createEmptyPurchaseForm = (purchasedAt = todayInputValue()) => ({
  itemName: '',
  usageUnit: '',
  purchaseUnit: '',
  unitsPerPurchaseUnit: '',
  supplier: '',
  paymentMethod: 'Cash',
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
  const restaurantBranch = useRestaurantBranch()
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
  const [inventoryView, setInventoryView] = useState<'stock' | 'preps'>('stock')
  const [showPrepForm, setShowPrepForm] = useState(false)
  const [prepSaving, setPrepSaving] = useState(false)
  const [prepError, setPrepError] = useState<string | null>(null)
  const [prepForm, setPrepForm] = useState({ name: '', unit: '', category: '' })
  const [editingPrepId, setEditingPrepId] = useState<string | null>(null)
  const [editPrepForm, setEditPrepForm] = useState({ name: '', unit: '', category: '' })
  const [expandedPrepId, setExpandedPrepId] = useState<string | null>(null)
  const [prepRecipes, setPrepRecipes] = useState<Record<string, PrepRecipeRow[]>>({})
  const [prepRecipeLoading, setPrepRecipeLoading] = useState<string | null>(null)
  const [prepRecipeError, setPrepRecipeError] = useState<string | null>(null)
  const [subRecipeForm, setSubRecipeForm] = useState({ ingredientItemId: '', quantityRequired: '' })
  const [editingSubRecipeId, setEditingSubRecipeId] = useState<string | null>(null)
  const [editSubRecipeQty, setEditSubRecipeQty] = useState('')
  const [subRecipeSaving, setSubRecipeSaving] = useState(false)

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
    const refreshInventoryData = () => {
      void load()
      void loadPurchases()
    }

    refreshInventoryData()
    window.addEventListener('refreshInventory', refreshInventoryData)
    window.addEventListener('online', refreshInventoryData)

    return () => {
      window.removeEventListener('refreshInventory', refreshInventoryData)
      window.removeEventListener('online', refreshInventoryData)
    }
  }, [restaurantBranch?.branchId])

  function upsertIngredient(nextIngredient: Ingredient | null | undefined) {
    if (!nextIngredient) return

    setItems((current) => {
      const existingIndex = current.findIndex((item) => item.id === nextIngredient.id)
      if (existingIndex === -1) {
        return [...current, nextIngredient].sort((left, right) => left.name.localeCompare(right.name))
      }

      return current.map((item) => item.id === nextIngredient.id ? nextIngredient : item)
    })
  }

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
      paymentMethod: (purchase as any).paymentMethod || 'Cash',
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
          paymentMethod: pForm.paymentMethod || 'Cash',
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
      const payload = await res.json().catch(() => null)
      if (payload?.purchase) {
        setPurchases((current) => [payload.purchase as Purchase, ...current])
      }
      upsertIngredient((payload?.ingredient ?? null) as Ingredient | null)
      window.dispatchEvent(new CustomEvent('refreshTransactions'))
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
    if (!editingPurchaseId || !pForm.itemName || !unitConfig.purchaseUnit || !unitConfig.usageUnit || pForm.purchaseQuantity === '' || !pForm.purchaseUnitCost) return
    if (!unitConfig.sameUnit && (!Number.isFinite(unitConfig.unitsPerPurchaseUnit) || unitConfig.unitsPerPurchaseUnit <= 0)) {
      setPurchaseError('Enter how many usage units exist in one purchase unit.')
      return
    }
    const existingPurchase = purchases.find((p) => p.id === editingPurchaseId)
    if (!existingPurchase) return

    const unitsPerPurchaseUnit = unitConfig.sameUnit ? 1 : unitConfig.unitsPerPurchaseUnit
    const purchaseQuantityInput = Number(pForm.purchaseQuantity)
    const purchaseUnitCostInput = Number(pForm.purchaseUnitCost)
    const quantityPurchased = toUsageQuantity(purchaseQuantityInput, unitsPerPurchaseUnit)
    const unitCost = toUsageUnitCost(purchaseUnitCostInput, unitsPerPurchaseUnit)
    const consumedSoFar = existingPurchase.quantityPurchased - existingPurchase.remainingQuantity
    const remainingQuantity = Math.max(0, quantityPurchased - consumedSoFar)
    const sameIngredient = normalizeInventoryItemName(existingPurchase.ingredient.name) === normalizeInventoryItemName(pForm.itemName)

    const optimisticPurchase: Purchase = {
      ...existingPurchase,
      supplier: pForm.supplier || null,
      purchaseQuantity: purchaseQuantityInput,
      purchaseUnit: unitConfig.purchaseUnit,
      unitsPerPurchaseUnit,
      purchaseUnitCost: purchaseUnitCostInput,
      quantityPurchased,
      remainingQuantity,
      unitCost,
      totalCost: quantityPurchased * unitCost,
      purchasedAt: pForm.purchasedAt,
      ingredient: { ...existingPurchase.ingredient, name: pForm.itemName, unit: unitConfig.usageUnit },
    }

    const previousPurchases = purchases
    const previousItems = items

    // Apply instantly and close the form - the save happens in the background.
    setPurchases((current) => current.map((p) => (p.id === editingPurchaseId ? optimisticPurchase : p)))
    if (sameIngredient) {
      setItems((current) => current.map((item) => item.id === existingPurchase.ingredientId
        ? { ...item, quantity: item.quantity + (remainingQuantity - existingPurchase.remainingQuantity) }
        : item))
    }
    cancelPurchaseEdit()

    try {
      const res = await fetch('/api/restaurant/inventory-purchases', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingPurchaseId,
          itemName: pForm.itemName,
          unit: unitConfig.usageUnit,
          purchaseUnit: unitConfig.purchaseUnit,
          unitsPerPurchaseUnit,
          supplier: pForm.supplier || null,
          paymentMethod: pForm.paymentMethod || 'Cash',
          purchaseQuantity: purchaseQuantityInput,
          purchaseUnitCost: purchaseUnitCostInput,
          purchasedAt: pForm.purchasedAt,
        })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setPurchases(previousPurchases)
        setItems(previousItems)
        setPurchaseError(err?.error || 'Update failed - change was reverted')
        return
      }
      const payload = await res.json().catch(() => null)
      if (payload?.purchase) {
        const updated = payload.purchase as Purchase
        setPurchases((current) => current.map((p) => (p.id === updated.id ? updated : p)))
      }
      for (const ingredient of (payload?.ingredients ?? []) as Ingredient[]) {
        upsertIngredient(ingredient)
      }
      window.dispatchEvent(new CustomEvent('refreshTransactions'))
    } catch {
      setPurchases(previousPurchases)
      setItems(previousItems)
      setPurchaseError('Update failed - change was reverted')
    }
  }

  async function deletePurchase(purchase: Purchase) {
    const confirmed = window.confirm(`Delete stock entry for ${purchase.ingredient.name}?`)
    if (!confirmed) return

    const previousPurchases = purchases
    const previousItems = items
    const lastInActiveBatch = activeBatchId && purchase.batchId === activeBatchId && activeBatchPurchases.length <= 1

    // Remove instantly and adjust on-hand stock right away - the delete happens in the background.
    if (editingPurchaseId === purchase.id || lastInActiveBatch) closePurchaseForm()
    setPurchases((current) => current.filter((p) => p.id !== purchase.id))
    setItems((current) => current.map((item) => item.id === purchase.ingredientId
      ? { ...item, quantity: item.quantity - purchase.remainingQuantity }
      : item))
    setPurchaseError(null)

    try {
      const res = await fetch(`/api/restaurant/inventory-purchases?id=${encodeURIComponent(purchase.id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setPurchases(previousPurchases)
        setItems(previousItems)
        setPurchaseError(err?.error || 'Delete failed - item was restored')
        return
      }
      const payload = await res.json().catch(() => null)
      upsertIngredient((payload?.ingredient ?? null) as Ingredient | null)
      window.dispatchEvent(new CustomEvent('refreshTransactions'))
    } catch {
      setPurchases(previousPurchases)
      setItems(previousItems)
      setPurchaseError('Delete failed - item was restored')
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

  async function savePrep() {
    if (!prepForm.name.trim() || !prepForm.unit.trim()) return
    setPrepSaving(true)
    setPrepError(null)
    try {
      const res = await fetch('/api/restaurant/ingredients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: prepForm.name.trim(), unit: prepForm.unit.trim(), category: prepForm.category.trim() || null, type: 'prep' }),
      })
      const data = await res.json()
      if (!res.ok) { setPrepError(data.error || 'Failed to save'); return }
      upsertIngredient(data as Ingredient)
      setPrepForm({ name: '', unit: '', category: '' })
      setShowPrepForm(false)
    } catch (e: any) {
      setPrepError(e?.message || 'Failed to save')
    } finally {
      setPrepSaving(false)
    }
  }

  async function updatePrep() {
    if (!editingPrepId || !editPrepForm.name.trim() || !editPrepForm.unit.trim()) return
    setPrepSaving(true)
    setPrepError(null)
    try {
      const res = await fetch('/api/restaurant/ingredients', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingPrepId, name: editPrepForm.name.trim(), unit: editPrepForm.unit.trim(), category: editPrepForm.category.trim() || null, type: 'prep', quantity: 0, reorderLevel: 0 }),
      })
      const data = await res.json()
      if (!res.ok) { setPrepError(data.error || 'Failed to update'); return }
      upsertIngredient(data as Ingredient)
      setEditingPrepId(null)
    } catch (e: any) {
      setPrepError(e?.message || 'Failed to update')
    } finally {
      setPrepSaving(false)
    }
  }

  async function deletePrep(id: string) {
    if (!window.confirm('Delete this prep? It will be removed from any dish recipes using it.')) return
    setPrepSaving(true)
    setPrepError(null)
    try {
      const res = await fetch(`/api/restaurant/ingredients?id=${id}`, { method: 'DELETE' })
      if (!res.ok) { setPrepError('Failed to delete'); return }
      setItems(cur => cur.filter(i => i.id !== id))
    } catch (e: any) {
      setPrepError(e?.message || 'Failed to delete')
    } finally {
      setPrepSaving(false)
    }
  }

  async function togglePrepRecipe(prepId: string) {
    if (expandedPrepId === prepId) { setExpandedPrepId(null); return }
    setExpandedPrepId(prepId)
    setSubRecipeForm({ ingredientItemId: '', quantityRequired: '' })
    setEditingSubRecipeId(null)
    if (prepRecipes[prepId] !== undefined) return
    setPrepRecipeLoading(prepId)
    setPrepRecipeError(null)
    try {
      const data = await fetch(`/api/restaurant/ingredients/prep-recipe?prepItemId=${prepId}`, FRESH_FETCH_OPTIONS).then(r => r.json())
      setPrepRecipes(cur => ({ ...cur, [prepId]: Array.isArray(data) ? data : [] }))
    } catch { setPrepRecipeError('Failed to load sub-recipe') }
    finally { setPrepRecipeLoading(null) }
  }

  async function addSubRecipeRow(prepId: string) {
    if (!subRecipeForm.ingredientItemId || !subRecipeForm.quantityRequired) return
    setSubRecipeSaving(true); setPrepRecipeError(null)
    try {
      const res = await fetch('/api/restaurant/ingredients/prep-recipe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prepItemId: prepId, ingredientItemId: subRecipeForm.ingredientItemId, quantityRequired: Number(subRecipeForm.quantityRequired) }),
      })
      const data = await res.json()
      if (!res.ok) { setPrepRecipeError(data.error || 'Failed to add'); return }
      setPrepRecipes(cur => ({ ...cur, [prepId]: [...(cur[prepId] || []), data as PrepRecipeRow] }))
      setSubRecipeForm({ ingredientItemId: '', quantityRequired: '' })
    } catch (e: any) { setPrepRecipeError(e?.message || 'Failed to add') }
    finally { setSubRecipeSaving(false) }
  }

  async function updateSubRecipeRow(id: string, prepId: string) {
    const qty = Number(editSubRecipeQty)
    if (!qty || qty <= 0) return
    setSubRecipeSaving(true); setPrepRecipeError(null)
    try {
      const res = await fetch('/api/restaurant/ingredients/prep-recipe', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, quantityRequired: qty }),
      })
      const data = await res.json()
      if (!res.ok) { setPrepRecipeError(data.error || 'Failed to update'); return }
      setPrepRecipes(cur => ({ ...cur, [prepId]: (cur[prepId] || []).map(r => r.id === id ? data as PrepRecipeRow : r) }))
      setEditingSubRecipeId(null)
    } catch (e: any) { setPrepRecipeError(e?.message || 'Failed to update') }
    finally { setSubRecipeSaving(false) }
  }

  async function deleteSubRecipeRow(id: string, prepId: string) {
    setSubRecipeSaving(true); setPrepRecipeError(null)
    try {
      const res = await fetch(`/api/restaurant/ingredients/prep-recipe?id=${id}`, { method: 'DELETE' })
      if (!res.ok) { setPrepRecipeError('Failed to remove'); return }
      setPrepRecipes(cur => ({ ...cur, [prepId]: (cur[prepId] || []).filter(r => r.id !== id) }))
    } catch (e: any) { setPrepRecipeError(e?.message || 'Failed to remove') }
    finally { setSubRecipeSaving(false) }
  }

  const prepItems = items.filter(i => i.type === 'prep')

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
    return !ingredientsWithLayerDrift.has(purchase.ingredientId)
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
  const knownSupplierNames = Array.from(new Set(
    purchases.map(p => (p.supplier ?? '').trim()).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b))
  const purchaseUnitOptions = pForm.purchaseUnit && !INVENTORY_UNITS.some(option => option.value === pForm.purchaseUnit)
    ? [{ value: pForm.purchaseUnit, label: pForm.purchaseUnit }, ...INVENTORY_UNITS]
    : INVENTORY_UNITS
  const usageUnitOptions = pForm.usageUnit && !INVENTORY_UNITS.some(option => option.value === pForm.usageUnit)
    ? [{ value: pForm.usageUnit, label: pForm.usageUnit }, ...INVENTORY_UNITS]
    : INVENTORY_UNITS

  function renderPurchaseRow(purchase: Purchase) {
    const purchaseLocked = !canMutatePurchase(purchase)
    const hasLayerDrift = ingredientsWithLayerDrift.has(purchase.ingredientId)
    const ingredient = items.find(item => item.id === purchase.ingredientId) ?? null
    const purchaseMeta = getPurchaseDisplayMeta(purchase)
    const displayedStockQuantity = purchase.remainingQuantity
    const displayedStockValue = displayedStockQuantity * purchase.unitCost
    const trackedStockDisplay = ingredient ? getIngredientStockDisplay(ingredient) : null
    const purchaseLockReason = 'This stock row is locked because stock has already moved on this ingredient.'

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
              <div className="space-y-1.5">
                <input value={pForm.supplier} onChange={e=>setPForm(f=>({...f,supplier:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown} list="inventory-known-suppliers"
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-300"
                  placeholder="Supplier (optional)"/>
                <select value={pForm.paymentMethod} onChange={e=>setPForm(f=>({...f,paymentMethod:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown}
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-amber-300">
                  {PURCHASE_PAYMENT_OPTIONS.map(m => <option key={m}>{m}</option>)}
                </select>
              </div>
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
                <button type="button" onClick={()=>void updatePurchase()} className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-amber-700">Done</button>
                <button type="button" onClick={cancelPurchaseEdit} className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-100">Cancel</button>
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
          <span
            title={hasLayerDrift ? 'Current stock is tracked at the ingredient level while FIFO batch layers are out of sync.' : undefined}
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${hasLayerDrift ? 'bg-amber-100 text-amber-800' : displayedStockQuantity<=0 ? 'bg-gray-100 text-gray-400' : 'bg-green-100 text-green-700'}`}
          >
            {hasLayerDrift && trackedStockDisplay
              ? `Current: ${trackedStockDisplay}`
              : formatStockOnHand(displayedStockQuantity, purchaseMeta.usageUnit, purchaseMeta.purchaseUnit, purchaseMeta.unitsPerPurchaseUnit)}
          </span>
        </td>
        <td className="px-4 py-3 font-semibold text-gray-900">{fmt(displayedStockValue)} RWF</td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={()=>openEditPurchase(purchase)}
              disabled={purchaseLocked}
              title={purchaseLocked ? purchaseLockReason : 'Edit stock row'}
              className={purchaseLocked
                ? 'rounded-md border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-300 cursor-not-allowed'
                : 'rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-50'}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={()=>void deletePurchase(purchase)}
              disabled={purchaseLocked}
              title={purchaseLocked ? purchaseLockReason : 'Delete stock row'}
              className={purchaseLocked
                ? 'rounded-md border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-300 cursor-not-allowed'
                : 'rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100'}
            >
              Delete
            </button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold text-gray-800">Inventory</h2>
          <BranchBadge />
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onAskJesse} className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-orange-300 text-orange-600 bg-white hover:bg-orange-50 transition-colors">
            <Sparkles className="h-3.5 w-3.5"/> Ask Jesse
          </button>
          {inventoryView === 'stock' ? (
            <button onClick={openNewPurchaseRow} className="bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              + Record new Batch
            </button>
          ) : (
            <button onClick={() => { setShowPrepForm(true); setEditingPrepId(null) }} className="bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              + New Prep
            </button>
          )}
        </div>
      </div>

      <div className="flex border-b border-gray-200">
        <button type="button" onClick={() => setInventoryView('stock')}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${inventoryView === 'stock' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          Stock
        </button>
        <button type="button" onClick={() => setInventoryView('preps')}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${inventoryView === 'preps' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          Preps
        </button>
      </div>

      {inventoryView === 'stock' && (<>
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
      {knownSupplierNames.length > 0 && (
        <datalist id="inventory-known-suppliers">
          {knownSupplierNames.map((name) => (
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
                      <div className="space-y-1.5">
                        <input value={pForm.supplier} onChange={e=>setPForm(f=>({...f,supplier:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown} list="inventory-known-suppliers"
                          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-300"
                          placeholder="Supplier (optional)"/>
                        <select value={pForm.paymentMethod} onChange={e=>setPForm(f=>({...f,paymentMethod:e.target.value}))} onKeyDown={handlePurchaseRowKeyDown}
                          className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-emerald-300">
                          {PURCHASE_PAYMENT_OPTIONS.map(m => <option key={m}>{m}</option>)}
                        </select>
                      </div>
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
      </>)}

      {inventoryView === 'preps' && (
        <div className="space-y-4">
          {(prepError || prepRecipeError) && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">{prepError || prepRecipeError}</div>
          )}

          {showPrepForm && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
              <p className="text-sm font-semibold text-gray-700">New Prep Item</p>
              <div className="flex flex-wrap gap-3">
                <input
                  value={prepForm.name}
                  onChange={e => setPrepForm(f => ({...f, name: e.target.value}))}
                  placeholder="Name (e.g. Fresh noodles)"
                  className="flex-1 min-w-[160px] rounded-md border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400"
                />
                <select
                  value={prepForm.unit}
                  onChange={e => setPrepForm(f => ({...f, unit: e.target.value}))}
                  className="rounded-md border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400"
                >
                  <option value="">Unit…</option>
                  {INVENTORY_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                </select>
                <input
                  value={prepForm.category}
                  onChange={e => setPrepForm(f => ({...f, category: e.target.value}))}
                  placeholder="Category (optional)"
                  className="rounded-md border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-400"
                />
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => void savePrep()} disabled={!prepForm.name.trim() || !prepForm.unit.trim() || prepSaving}
                  className="rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-600 disabled:opacity-50">
                  Save
                </button>
                <button type="button" onClick={() => { setShowPrepForm(false); setPrepForm({ name: '', unit: '', category: '' }) }} disabled={prepSaving}
                  className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-100 disabled:opacity-50">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {prepItems.length === 0 && !showPrepForm ? (
            <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
              <p className="font-medium text-gray-600">No prep items yet</p>
              <p className="text-sm text-gray-400 mt-1">Add in-house prepared ingredients like fresh noodles, dumplings, or sauces — they appear as normal ingredients when building dish recipes.</p>
            </div>
          ) : prepItems.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Item</th>
                    <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Unit</th>
                    <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Category</th>
                    <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {prepItems.map(item => (
                    <Fragment key={item.id}>
                    {editingPrepId === item.id ? (
                      <tr className="bg-amber-50/80">
                        <td className="px-3 py-2">
                          <input value={editPrepForm.name} onChange={e => setEditPrepForm(f => ({...f, name: e.target.value}))}
                            className="w-full rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-amber-300"/>
                        </td>
                        <td className="px-3 py-2">
                          <select value={editPrepForm.unit} onChange={e => setEditPrepForm(f => ({...f, unit: e.target.value}))}
                            className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-amber-300">
                            <option value="">Unit…</option>
                            {INVENTORY_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <input value={editPrepForm.category} onChange={e => setEditPrepForm(f => ({...f, category: e.target.value}))}
                            className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-amber-300"/>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex gap-2">
                            <button type="button" onClick={() => void updatePrep()} disabled={prepSaving}
                              className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50">Save</button>
                            <button type="button" onClick={() => setEditingPrepId(null)} disabled={prepSaving}
                              className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-100 disabled:opacity-50">Cancel</button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 font-medium text-gray-900">{item.name}</td>
                        <td className="px-4 py-3 text-gray-700">{item.unit}</td>
                        <td className="px-4 py-3 text-gray-500">{item.category || '—'}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-2 flex-wrap">
                            <button type="button"
                              onClick={() => void togglePrepRecipe(item.id)}
                              className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors ${expandedPrepId === item.id ? 'border-orange-400 bg-orange-50 text-orange-600' : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}`}>
                              Recipe {expandedPrepId === item.id ? '▲' : '▼'}
                            </button>
                            <button type="button"
                              onClick={() => { setEditingPrepId(item.id); setEditPrepForm({ name: item.name, unit: item.unit, category: item.category || '' }) }}
                              disabled={prepSaving}
                              className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                              Edit
                            </button>
                            <button type="button"
                              onClick={() => void deletePrep(item.id)}
                              disabled={prepSaving}
                              className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-100 disabled:opacity-50">
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {expandedPrepId === item.id && editingPrepId !== item.id && (
                      <tr className="bg-orange-50/60">
                        <td colSpan={4} className="px-6 py-4 border-b border-orange-100">
                          <p className="text-xs font-semibold text-gray-700 mb-2">
                            Sub-recipe for <span className="text-orange-600">{item.name}</span> — quantities per 1 {item.unit}
                          </p>
                          {prepRecipeLoading === item.id ? (
                            <p className="text-xs text-gray-400">Loading…</p>
                          ) : (
                            <div className="space-y-1.5">
                              {(prepRecipes[item.id] || []).length === 0 && (
                                <p className="text-xs text-gray-400 italic">No raw ingredients defined yet — add them below.</p>
                              )}
                              {(prepRecipes[item.id] || []).map(row => (
                                <div key={row.id} className="flex items-center gap-2 text-xs">
                                  {editingSubRecipeId === row.id ? (
                                    <>
                                      <span className="font-medium text-gray-700 w-40 shrink-0">{row.ingredient.name}</span>
                                      <input type="number" min="0.0001" step="any" value={editSubRecipeQty}
                                        onChange={e => setEditSubRecipeQty(e.target.value)}
                                        className="w-20 rounded border border-gray-200 px-2 py-1 outline-none focus:ring-2 focus:ring-orange-300"/>
                                      <span className="text-gray-500">{row.ingredient.unit}</span>
                                      <button type="button" onClick={() => void updateSubRecipeRow(row.id, item.id)} disabled={subRecipeSaving}
                                        className="text-green-600 font-semibold hover:underline disabled:opacity-50">Save</button>
                                      <button type="button" onClick={() => setEditingSubRecipeId(null)}
                                        className="text-gray-400 hover:underline">Cancel</button>
                                    </>
                                  ) : (
                                    <>
                                      <span className="font-medium text-gray-700 w-40 shrink-0">{row.ingredient.name}</span>
                                      <span className="text-gray-900 font-mono">{row.quantityRequired}</span>
                                      <span className="text-gray-500">{row.ingredient.unit}</span>
                                      <button type="button"
                                        onClick={() => { setEditingSubRecipeId(row.id); setEditSubRecipeQty(String(row.quantityRequired)) }}
                                        className="text-blue-500 hover:underline">Edit</button>
                                      <button type="button" onClick={() => void deleteSubRecipeRow(row.id, item.id)} disabled={subRecipeSaving}
                                        className="text-red-400 hover:underline disabled:opacity-50">Remove</button>
                                    </>
                                  )}
                                </div>
                              ))}
                              <div className="flex items-center gap-2 pt-2 border-t border-orange-100 mt-2">
                                <select value={subRecipeForm.ingredientItemId}
                                  onChange={e => setSubRecipeForm(f => ({...f, ingredientItemId: e.target.value}))}
                                  className="text-xs rounded border border-gray-200 px-2 py-1.5 outline-none focus:ring-2 focus:ring-orange-300 min-w-[160px]">
                                  <option value="">+ Raw ingredient…</option>
                                  {items.filter(i => i.type !== 'prep').map(i => (
                                    <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>
                                  ))}
                                </select>
                                <input type="number" min="0.0001" step="any" value={subRecipeForm.quantityRequired}
                                  onChange={e => setSubRecipeForm(f => ({...f, quantityRequired: e.target.value}))}
                                  placeholder="Qty"
                                  className="w-20 text-xs rounded border border-gray-200 px-2 py-1.5 outline-none focus:ring-2 focus:ring-orange-300"/>
                                <button type="button"
                                  onClick={() => void addSubRecipeRow(item.id)}
                                  disabled={!subRecipeForm.ingredientItemId || !subRecipeForm.quantityRequired || subRecipeSaving}
                                  className="rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-600 disabled:opacity-40">
                                  Add
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

    </div>
  )
}



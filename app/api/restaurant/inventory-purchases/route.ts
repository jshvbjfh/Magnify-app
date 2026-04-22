import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { recordJournalEntry } from '@/lib/accounting'
import { getActiveFifoUnitCost } from '@/lib/fifoCosting'
import {
  getPurchaseUnit,
  getUnitsPerPurchaseUnit,
  normalizeInventoryUnit,
  normalizeUnitsPerPurchaseUnit,
  toPurchaseQuantity,
  toPurchaseUnitCost,
  toUsageQuantity,
  toUsageUnitCost,
} from '@/lib/inventoryUnits'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { generateInventoryBatchId } from '@/lib/inventoryBatch'
import { enqueueSyncChange } from '@/lib/syncOutbox'
import type { Prisma } from '@prisma/client'

const PURCHASE_USAGE_EPSILON = 0.000001
const INVENTORY_TRANSACTION_OPTIONS = { maxWait: 10000, timeout: 20000 } as const

function buildInventoryPurchaseDescription(params: {
  ingredientName: string
  ingredientUnit: string
  quantityPurchased: number
  purchaseQuantity?: number | null
  purchaseUnit?: string | null
  supplier: string | null
}) {
  const quantity = Number(params.purchaseQuantity ?? params.quantityPurchased)
  const unit = normalizeInventoryUnit(params.purchaseUnit) || params.ingredientUnit
  return `Purchase: ${params.ingredientName} (${formatInventoryNumber(quantity)} ${unit}${params.supplier ? ` from ${params.supplier}` : ''})`
}

function hasConsumedPurchaseQuantity(purchase: { quantityPurchased: number; remainingQuantity: number }) {
  return purchase.quantityPurchased - purchase.remainingQuantity > PURCHASE_USAGE_EPSILON
}

function normalizeInventoryItemName(name: string) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

function sanitizeInventoryItemName(name: string) {
  return name.trim().replace(/\s+/g, ' ')
}

function sanitizeInventoryUnit(unit: string) {
  return unit.trim().replace(/\s+/g, ' ')
}

function formatInventoryNumber(value: number) {
  return Number(value || 0).toLocaleString('en-RW', { maximumFractionDigits: 3 })
}

function resolveIngredientUnitConfig(params: {
  unit?: string | null
  purchaseUnit?: string | null
  unitsPerPurchaseUnit?: number | null
  fallbackUnit?: string | null
  fallbackPurchaseUnit?: string | null
  fallbackUnitsPerPurchaseUnit?: number | null
}) {
  const usageUnit = sanitizeInventoryUnit(params.unit || params.fallbackUnit || '')
  if (!usageUnit) {
    throw new Error('unit is required when recording a new item')
  }

  const purchaseUnit = sanitizeInventoryUnit(params.purchaseUnit || params.fallbackPurchaseUnit || usageUnit)
  const usageMatchesPurchaseUnit = usageUnit.toLowerCase() === purchaseUnit.toLowerCase()
  const rawUnitsPerPurchaseUnit = params.unitsPerPurchaseUnit ?? params.fallbackUnitsPerPurchaseUnit
  if (!usageMatchesPurchaseUnit && (!Number.isFinite(Number(rawUnitsPerPurchaseUnit)) || Number(rawUnitsPerPurchaseUnit) <= 0)) {
    throw new Error('unitsPerPurchaseUnit is required when purchase unit differs from usage unit')
  }

  const unitsPerPurchaseUnit = usageMatchesPurchaseUnit
    ? 1
    : normalizeUnitsPerPurchaseUnit(rawUnitsPerPurchaseUnit, 1)

  return {
    usageUnit,
    purchaseUnit,
    unitsPerPurchaseUnit,
  }
}

function resolvePurchaseNumbers(params: {
  quantityPurchased?: unknown
  unitCost?: unknown
  purchaseQuantity?: unknown
  purchaseUnitCost?: unknown
  unitsPerPurchaseUnit: number
}) {
  const hasPurchaseSideInput = params.purchaseQuantity != null || params.purchaseUnitCost != null

  if (hasPurchaseSideInput) {
    const purchaseQuantity = Number(params.purchaseQuantity)
    const purchaseUnitCost = Number(params.purchaseUnitCost)
    if (!Number.isFinite(purchaseQuantity) || purchaseQuantity <= 0) {
      throw new Error('purchaseQuantity must be a valid number greater than 0')
    }
    if (!Number.isFinite(purchaseUnitCost) || purchaseUnitCost < 0) {
      throw new Error('purchaseUnitCost must be a valid number greater than or equal to 0')
    }

    const quantityPurchased = toUsageQuantity(purchaseQuantity, params.unitsPerPurchaseUnit)
    const unitCost = toUsageUnitCost(purchaseUnitCost, params.unitsPerPurchaseUnit)
    return {
      purchaseQuantity,
      purchaseUnitCost,
      quantityPurchased,
      unitCost,
      totalCost: purchaseQuantity * purchaseUnitCost,
    }
  }

  const quantityPurchased = Number(params.quantityPurchased)
  const unitCost = Number(params.unitCost)
  if (!Number.isFinite(quantityPurchased) || quantityPurchased <= 0) {
    throw new Error('quantityPurchased must be a valid number greater than 0')
  }
  if (!Number.isFinite(unitCost) || unitCost < 0) {
    throw new Error('unitCost must be a valid number greater than or equal to 0')
  }

  return {
    purchaseQuantity: toPurchaseQuantity(quantityPurchased, params.unitsPerPurchaseUnit),
    purchaseUnitCost: toPurchaseUnitCost(unitCost, params.unitsPerPurchaseUnit),
    quantityPurchased,
    unitCost,
    totalCost: quantityPurchased * unitCost,
  }
}

type ResolvedInventoryIngredient = {
  id: string
  name: string
  unit: string
  purchaseUnit: string | null
  unitsPerPurchaseUnit: number | null
  unitCost: number | null
  quantity: number
}

async function resolveInventoryIngredient(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    restaurantId: string
    branchId: string
    ingredientId?: string | null
    itemName?: string | null
    unit?: string | null
    purchaseUnit?: string | null
    unitsPerPurchaseUnit?: number | null
    unitCost?: number | null
    syncPurchaseDefaults?: boolean
  }
): Promise<ResolvedInventoryIngredient> {
  let matchedIngredient: ResolvedInventoryIngredient | null = null

  if (params.ingredientId) {
    matchedIngredient = await tx.inventoryItem.findFirst({
      where: {
        id: params.ingredientId,
        userId: params.userId,
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        inventoryType: 'ingredient',
      },
      select: { id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true, unitCost: true, quantity: true },
    })

    if (!matchedIngredient) {
      throw new Error('Ingredient not found')
    }
  }

  const normalizedItemName = normalizeInventoryItemName(params.itemName || '')
  const sanitizedItemName = sanitizeInventoryItemName(params.itemName || '')
  if (!matchedIngredient && (!normalizedItemName || !sanitizedItemName)) {
    throw new Error('itemName is required')
  }

  if (!matchedIngredient) {
    const existingIngredients = await tx.inventoryItem.findMany({
      where: {
        userId: params.userId,
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        inventoryType: 'ingredient',
      },
      select: { id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true, unitCost: true, quantity: true },
    })

    matchedIngredient = existingIngredients.find((ingredient) => normalizeInventoryItemName(ingredient.name) === normalizedItemName) ?? null
  }

  if (matchedIngredient) {
    const nextUnitConfig = resolveIngredientUnitConfig({
      unit: params.unit,
      purchaseUnit: params.purchaseUnit,
      unitsPerPurchaseUnit: params.unitsPerPurchaseUnit,
      fallbackUnit: matchedIngredient.unit,
      fallbackPurchaseUnit: getPurchaseUnit(matchedIngredient),
      fallbackUnitsPerPurchaseUnit: getUnitsPerPurchaseUnit(matchedIngredient),
    })

    const usageUnitChanged = matchedIngredient.unit.toLowerCase() !== nextUnitConfig.usageUnit.toLowerCase()
    const purchaseDefaultsChanged = getPurchaseUnit(matchedIngredient).toLowerCase() !== nextUnitConfig.purchaseUnit.toLowerCase()
      || Math.abs(getUnitsPerPurchaseUnit(matchedIngredient) - nextUnitConfig.unitsPerPurchaseUnit) > PURCHASE_USAGE_EPSILON

    if (!usageUnitChanged && !purchaseDefaultsChanged) {
      return matchedIngredient
    }

    if (usageUnitChanged) {
      const openPurchaseCount = await tx.inventoryPurchase.count({
        where: {
          userId: params.userId,
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          ingredientId: matchedIngredient.id,
          remainingQuantity: { gt: PURCHASE_USAGE_EPSILON },
        },
      })

      if (Number(matchedIngredient.quantity || 0) > PURCHASE_USAGE_EPSILON || openPurchaseCount > 0) {
        throw new Error('This ingredient already has stock history. You can change future pack size, but you cannot change the usage unit until existing stock is cleared.')
      }
    }

    if (!usageUnitChanged && purchaseDefaultsChanged && params.syncPurchaseDefaults === false) {
      return matchedIngredient
    }

    return tx.inventoryItem.update({
      where: { id: matchedIngredient.id },
      data: {
        unit: nextUnitConfig.usageUnit,
        purchaseUnit: nextUnitConfig.purchaseUnit.toLowerCase() === nextUnitConfig.usageUnit.toLowerCase()
          ? null
          : nextUnitConfig.purchaseUnit,
        unitsPerPurchaseUnit: nextUnitConfig.unitsPerPurchaseUnit === 1 ? null : nextUnitConfig.unitsPerPurchaseUnit,
        ...(params.unitCost !== undefined ? { unitCost: params.unitCost ?? null } : {}),
      },
      select: { id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true, unitCost: true, quantity: true },
    })
  }

  const nextUnitConfig = resolveIngredientUnitConfig({
    unit: params.unit,
    purchaseUnit: params.purchaseUnit,
    unitsPerPurchaseUnit: params.unitsPerPurchaseUnit,
  })

  return tx.inventoryItem.create({
    data: {
      userId: params.userId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      name: sanitizedItemName,
      unit: nextUnitConfig.usageUnit,
      purchaseUnit: nextUnitConfig.purchaseUnit.toLowerCase() === nextUnitConfig.usageUnit.toLowerCase()
        ? null
        : nextUnitConfig.purchaseUnit,
      unitsPerPurchaseUnit: nextUnitConfig.unitsPerPurchaseUnit === 1 ? null : nextUnitConfig.unitsPerPurchaseUnit,
      unitCost: params.unitCost ?? null,
      quantity: 0,
      reorderLevel: 0,
      category: null,
      inventoryType: 'ingredient',
    },
    select: { id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true, unitCost: true, quantity: true },
  })
}

async function resolvePurchaseJournalPairId(
  tx: Prisma.TransactionClient,
  purchase: {
    journalPairId?: string | null
    userId: string
    restaurantId: string | null
    branchId?: string | null
    supplier: string | null
    quantityPurchased: number
    purchaseQuantity?: number | null
    purchaseUnit?: string | null
    totalCost: number
    purchasedAt: Date
    ingredient: { name: string; unit: string }
  }
) {
  const storedPairId = purchase.journalPairId?.trim()
  if (storedPairId) return { pairId: storedPairId, resolution: 'stored' as const }

  const pairMatches = await tx.transaction.findMany({
    where: {
      userId: purchase.userId,
      restaurantId: purchase.restaurantId,
      branchId: purchase.branchId ?? null,
      sourceKind: 'inventory_purchase',
      pairId: { not: null },
      description: buildInventoryPurchaseDescription({
        ingredientName: purchase.ingredient.name,
        ingredientUnit: purchase.ingredient.unit,
        quantityPurchased: purchase.quantityPurchased,
        purchaseQuantity: purchase.purchaseQuantity ?? null,
        purchaseUnit: purchase.purchaseUnit ?? null,
        supplier: purchase.supplier,
      }),
      amount: purchase.totalCost,
      date: purchase.purchasedAt,
    },
    select: { pairId: true },
    distinct: ['pairId'],
  })

  if (pairMatches.length === 1 && pairMatches[0].pairId) {
    return { pairId: pairMatches[0].pairId, resolution: 'matched' as const }
  }

  if (pairMatches.length > 1) {
    return { pairId: null, resolution: 'ambiguous' as const }
  }

  return { pairId: null, resolution: 'missing' as const }
}

async function resolveIngredientActiveUnitCost(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    restaurantId: string
    branchId: string
    ingredientId: string
    fallbackUnitCost: number | null
  },
) {
  const openLayers = await tx.inventoryPurchase.findMany({
    where: {
      userId: params.userId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      ingredientId: params.ingredientId,
      remainingQuantity: { gt: PURCHASE_USAGE_EPSILON },
    },
    select: {
      id: true,
      remainingQuantity: true,
      unitCost: true,
      purchasedAt: true,
      createdAt: true,
    },
    orderBy: [{ purchasedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })

  return getActiveFifoUnitCost(openLayers, params.fallbackUnitCost)
}

async function syncIngredientActiveUnitCost(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    restaurantId: string
    branchId: string
    ingredientId: string
  },
) {
  const ingredient = await tx.inventoryItem.findFirst({
    where: {
      id: params.ingredientId,
      userId: params.userId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      inventoryType: 'ingredient',
    },
  })

  if (!ingredient) return null

  const activeUnitCost = await resolveIngredientActiveUnitCost(tx, {
    userId: params.userId,
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    ingredientId: params.ingredientId,
    fallbackUnitCost: ingredient.unitCost,
  })

  if (ingredient.unitCost === activeUnitCost) return ingredient

  return tx.inventoryItem.update({
    where: { id: ingredient.id },
    data: { unitCost: activeUnitCost },
  })
}

// GET — list all purchase batches for this user
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = await getRestaurantContextForUser(session.user.id)
    const billingUserId = context?.billingUserId ?? session.user.id
    const restaurantId = context?.restaurantId ?? null
    const branchId = context?.branchId ?? null

    if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

    const { searchParams } = new URL(req.url)
    const ingredientId = searchParams.get('ingredientId')
    const from = searchParams.get('from')
    const to = searchParams.get('to')

    const purchases = await prisma.inventoryPurchase.findMany({
      where: {
        userId: billingUserId,
        restaurantId,
        branchId,
        ...(ingredientId ? { ingredientId } : {}),
        ...(from && to ? { purchasedAt: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } } : {}),
      },
      include: { ingredient: { select: { name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true } } },
      orderBy: [{ createdAt: 'desc' }, { purchasedAt: 'desc' }],
    })

    return NextResponse.json(purchases)
  } catch (error: any) {
    console.error('Failed to load inventory purchases:', error)
    return NextResponse.json({ error: error?.message || 'Failed to load inventory purchases' }, { status: 500 })
  }
}

// POST — record a new purchase batch
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = await getRestaurantContextForUser(session.user.id)
    const billingUserId = context?.billingUserId ?? session.user.id
    const restaurantId = context?.restaurantId ?? null
    const branchId = context?.branchId ?? null

    if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

    const body = await req.json()
    const { ingredientId, itemName, unit, purchaseUnit, unitsPerPurchaseUnit, supplier, quantityPurchased, unitCost, purchaseQuantity, purchaseUnitCost, purchasedAt, paymentMethod, batchId } = body

    if (!ingredientId && !(typeof itemName === 'string' && itemName.trim())) {
      return NextResponse.json({ error: 'itemName or ingredientId is required' }, { status: 400 })
    }

    const unitConfig = resolveIngredientUnitConfig({
      unit,
      purchaseUnit,
      unitsPerPurchaseUnit,
      fallbackUnit: typeof unit === 'string' ? unit : null,
      fallbackPurchaseUnit: typeof purchaseUnit === 'string' ? purchaseUnit : null,
      fallbackUnitsPerPurchaseUnit: typeof unitsPerPurchaseUnit === 'number' ? unitsPerPurchaseUnit : null,
    })

    let resolvedNumbers
    try {
      resolvedNumbers = resolvePurchaseNumbers({
        quantityPurchased,
        unitCost,
        purchaseQuantity,
        purchaseUnitCost,
        unitsPerPurchaseUnit: unitConfig.unitsPerPurchaseUnit,
      })
    } catch (error: any) {
      return NextResponse.json({ error: error?.message || 'Invalid purchase quantity or cost' }, { status: 400 })
    }

    const requestedPurchaseDate = purchasedAt ? new Date(purchasedAt) : new Date()
    if (Number.isNaN(requestedPurchaseDate.getTime())) {
      return NextResponse.json({ error: 'purchasedAt must be a valid date' }, { status: 400 })
    }

    const requestedBatchId = typeof batchId === 'string' && batchId.trim() ? batchId.trim() : null

    const purchase = await prisma.$transaction(async (tx) => {
      const ingredient = await resolveInventoryIngredient(tx, {
        userId: billingUserId,
        restaurantId,
        branchId,
        ingredientId,
        itemName,
        unit: unitConfig.usageUnit,
        purchaseUnit: unitConfig.purchaseUnit,
        unitsPerPurchaseUnit: unitConfig.unitsPerPurchaseUnit,
        unitCost: resolvedNumbers.unitCost,
        syncPurchaseDefaults: true,
      })

      const existingBatch = requestedBatchId
        ? await tx.inventoryPurchase.findFirst({
            where: {
              userId: billingUserId,
              restaurantId,
              branchId,
              batchId: requestedBatchId,
            },
            orderBy: { purchasedAt: 'asc' },
            select: { batchId: true, purchasedAt: true },
          })
        : null

      const resolvedBatchId = existingBatch?.batchId ?? requestedBatchId ?? generateInventoryBatchId(requestedPurchaseDate)
      const resolvedPurchaseDate = existingBatch?.purchasedAt ?? requestedPurchaseDate
      const normalizedPaymentMethod = typeof paymentMethod === 'string' && paymentMethod.trim() ? paymentMethod.trim() : 'Cash'

      const journalEntry = await recordJournalEntry(tx, {
        userId: billingUserId,
        restaurantId,
        branchId,
        date: resolvedPurchaseDate,
        description: buildInventoryPurchaseDescription({
          ingredientName: ingredient.name,
          ingredientUnit: ingredient.unit,
          quantityPurchased: resolvedNumbers.quantityPurchased,
          purchaseQuantity: resolvedNumbers.purchaseQuantity,
          purchaseUnit: unitConfig.purchaseUnit,
          supplier: supplier || null,
        }),
        amount: resolvedNumbers.totalCost,
        direction: 'out',
        accountName: 'Inventory Purchases',
        categoryType: 'expense',
        paymentMethod: normalizedPaymentMethod,
        isManual: true,
        sourceKind: 'inventory_purchase',
      })

      const createdPurchase = await tx.inventoryPurchase.create({
        data: {
          userId: billingUserId,
          restaurantId,
          branchId,
          batchId: resolvedBatchId,
          journalPairId: journalEntry.pairId ?? null,
          ingredientId: ingredient.id,
          supplier: supplier || null,
          purchaseQuantity: resolvedNumbers.purchaseQuantity,
          purchaseUnit: unitConfig.purchaseUnit,
          unitsPerPurchaseUnit: unitConfig.unitsPerPurchaseUnit,
          purchaseUnitCost: resolvedNumbers.purchaseUnitCost,
          quantityPurchased: resolvedNumbers.quantityPurchased,
          remainingQuantity: resolvedNumbers.quantityPurchased,
          unitCost: resolvedNumbers.unitCost,
          totalCost: resolvedNumbers.totalCost,
          purchasedAt: resolvedPurchaseDate,
        },
      })

      await tx.inventoryItem.update({
        where: { id: ingredient.id },
        data: {
          quantity: { increment: resolvedNumbers.quantityPurchased },
          lastRestockedAt: resolvedPurchaseDate,
        },
      })

      const updatedIngredient = await syncIngredientActiveUnitCost(tx, {
        userId: billingUserId,
        restaurantId,
        branchId,
        ingredientId: ingredient.id,
      })
      if (!updatedIngredient) throw new Error('Ingredient not found after stock entry was created.')

      await enqueueSyncChange(tx, {
        restaurantId,
        branchId,
        entityType: 'inventoryPurchase',
        entityId: createdPurchase.id,
        operation: 'upsert',
        payload: createdPurchase,
      })

      await enqueueSyncChange(tx, {
        restaurantId,
        branchId,
        entityType: 'inventoryItem',
        entityId: updatedIngredient.id,
        operation: 'upsert',
        payload: updatedIngredient,
      })

      return createdPurchase
    }, INVENTORY_TRANSACTION_OPTIONS)

    return NextResponse.json({ purchase, totalCost: resolvedNumbers.totalCost, batchId: purchase.batchId }, { status: 201 })
  } catch (error: any) {
    console.error('Failed to record inventory purchase:', error)
    const status = error?.message === 'Ingredient not found'
      || error?.message === 'itemName is required'
      || error?.message === 'unit is required when recording a new item'
      || error?.message?.includes('cannot change the usage unit')
      ? 400
      : 500
    return NextResponse.json({ error: error?.message || 'Failed to record inventory purchase', code: error?.code || null }, { status })
  }
}

export async function PUT(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = await getRestaurantContextForUser(session.user.id)
    const billingUserId = context?.billingUserId ?? session.user.id
    const restaurantId = context?.restaurantId ?? null
    const branchId = context?.branchId ?? null

    if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

    const body = await req.json()
    const { id, ingredientId, itemName, unit, purchaseUnit, unitsPerPurchaseUnit, supplier, quantityPurchased, unitCost, purchaseQuantity, purchaseUnitCost, purchasedAt, paymentMethod } = body

    if (!id || (!ingredientId && !(typeof itemName === 'string' && itemName.trim()))) {
      return NextResponse.json({ error: 'id and itemName or ingredientId are required' }, { status: 400 })
    }

    const resolvedPurchaseDate = purchasedAt ? new Date(purchasedAt) : new Date()
    if (Number.isNaN(resolvedPurchaseDate.getTime())) {
      return NextResponse.json({ error: 'purchasedAt must be a valid date' }, { status: 400 })
    }

    const existingPurchase = await prisma.inventoryPurchase.findFirst({
      where: {
        id,
        userId: billingUserId,
        restaurantId,
        branchId,
      },
      include: {
        ingredient: { select: { id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true } },
      },
    })

    if (!existingPurchase) {
      return NextResponse.json({ error: 'Stock entry not found' }, { status: 404 })
    }

    if (hasConsumedPurchaseQuantity(existingPurchase)) {
      return NextResponse.json({ error: 'This stock entry has already been used by orders, so editing is locked.' }, { status: 409 })
    }

    const unitConfig = resolveIngredientUnitConfig({
      unit,
      purchaseUnit,
      unitsPerPurchaseUnit,
      fallbackUnit: existingPurchase.ingredient.unit,
      fallbackPurchaseUnit: existingPurchase.purchaseUnit ?? existingPurchase.ingredient.purchaseUnit ?? existingPurchase.ingredient.unit,
      fallbackUnitsPerPurchaseUnit: existingPurchase.unitsPerPurchaseUnit ?? existingPurchase.ingredient.unitsPerPurchaseUnit ?? 1,
    })

    let resolvedNumbers
    try {
      resolvedNumbers = resolvePurchaseNumbers({
        quantityPurchased,
        unitCost,
        purchaseQuantity,
        purchaseUnitCost,
        unitsPerPurchaseUnit: unitConfig.unitsPerPurchaseUnit,
      })
    } catch (error: any) {
      return NextResponse.json({ error: error?.message || 'Invalid purchase quantity or cost' }, { status: 400 })
    }

    const normalizedPaymentMethod = typeof paymentMethod === 'string' && paymentMethod.trim() ? paymentMethod.trim() : 'Cash'

    const updatedPurchase = await prisma.$transaction(async (tx) => {
      const journalLink = await resolvePurchaseJournalPairId(tx, existingPurchase)
      if (!journalLink.pairId) {
        throw new Error(journalLink.resolution === 'ambiguous'
          ? 'This stock entry matches multiple accounting records and cannot be edited safely.'
          : 'This stock entry is not linked to its accounting records, so editing is blocked to keep reports correct.')
      }

      const nextIngredient = await resolveInventoryIngredient(tx, {
        userId: billingUserId,
        restaurantId,
        branchId,
        ingredientId,
        itemName,
        unit: unitConfig.usageUnit,
        purchaseUnit: unitConfig.purchaseUnit,
        unitsPerPurchaseUnit: unitConfig.unitsPerPurchaseUnit,
        unitCost: resolvedNumbers.unitCost,
        syncPurchaseDefaults: false,
      })

      if (existingPurchase.ingredientId === nextIngredient.id) {
        await tx.inventoryItem.update({
          where: { id: nextIngredient.id },
          data: {
            quantity: { increment: resolvedNumbers.quantityPurchased - existingPurchase.quantityPurchased },
            lastRestockedAt: resolvedPurchaseDate,
          },
        })
      } else {
        await tx.inventoryItem.update({
          where: { id: existingPurchase.ingredientId },
          data: {
            quantity: { decrement: existingPurchase.quantityPurchased },
          },
        })

        await tx.inventoryItem.update({
          where: { id: nextIngredient.id },
          data: {
            quantity: { increment: resolvedNumbers.quantityPurchased },
            lastRestockedAt: resolvedPurchaseDate,
          },
        })
      }

      const updatedTransactions = await tx.transaction.updateMany({
        where: {
          userId: billingUserId,
          restaurantId,
          branchId,
          pairId: journalLink.pairId,
          sourceKind: 'inventory_purchase',
        },
        data: {
          date: resolvedPurchaseDate,
          description: buildInventoryPurchaseDescription({
            ingredientName: nextIngredient.name,
            ingredientUnit: nextIngredient.unit,
            quantityPurchased: resolvedNumbers.quantityPurchased,
            purchaseQuantity: resolvedNumbers.purchaseQuantity,
            purchaseUnit: unitConfig.purchaseUnit,
            supplier: supplier || null,
          }),
          amount: resolvedNumbers.totalCost,
          paymentMethod: normalizedPaymentMethod,
        },
      })

      if (updatedTransactions.count === 0) {
        throw new Error('This stock entry is missing its accounting records, so editing is blocked to keep reports correct.')
      }

      const purchase = await tx.inventoryPurchase.update({
        where: { id },
        data: {
          journalPairId: journalLink.pairId,
          ingredientId: nextIngredient.id,
          supplier: supplier || null,
          purchaseQuantity: resolvedNumbers.purchaseQuantity,
          purchaseUnit: unitConfig.purchaseUnit,
          unitsPerPurchaseUnit: unitConfig.unitsPerPurchaseUnit,
          purchaseUnitCost: resolvedNumbers.purchaseUnitCost,
          quantityPurchased: resolvedNumbers.quantityPurchased,
          remainingQuantity: resolvedNumbers.quantityPurchased,
          unitCost: resolvedNumbers.unitCost,
          totalCost: resolvedNumbers.totalCost,
          purchasedAt: resolvedPurchaseDate,
        },
      })

      const syncedIngredientIds = new Set([existingPurchase.ingredientId, nextIngredient.id])
      for (const syncedIngredientId of syncedIngredientIds) {
        const syncedIngredient = await syncIngredientActiveUnitCost(tx, {
          userId: billingUserId,
          restaurantId,
          branchId,
          ingredientId: syncedIngredientId,
        })
        if (!syncedIngredient) continue
        await enqueueSyncChange(tx, {
          restaurantId,
          branchId,
          entityType: 'inventoryItem',
          entityId: syncedIngredient.id,
          operation: 'upsert',
          payload: syncedIngredient,
        })
      }

      await enqueueSyncChange(tx, {
        restaurantId,
        branchId,
        entityType: 'inventoryPurchase',
        entityId: purchase.id,
        operation: 'upsert',
        payload: purchase,
      })

      return purchase
    }, INVENTORY_TRANSACTION_OPTIONS)

    return NextResponse.json({ purchase: updatedPurchase })
  } catch (error: any) {
    console.error('Failed to update inventory purchase:', error)
    const status = error?.message === 'Ingredient not found'
      || error?.message === 'itemName is required'
      || error?.message === 'unit is required when recording a new item'
      || error?.message?.includes('cannot change the usage unit')
      ? 400
      : 500
    return NextResponse.json({ error: error?.message || 'Failed to update inventory purchase', code: error?.code || null }, { status })
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = await getRestaurantContextForUser(session.user.id)
    const billingUserId = context?.billingUserId ?? session.user.id
    const restaurantId = context?.restaurantId ?? null
    const branchId = context?.branchId ?? null

    if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'Stock entry id is required' }, { status: 400 })

    const existingPurchase = await prisma.inventoryPurchase.findFirst({
      where: {
        id,
        userId: billingUserId,
        restaurantId,
        branchId,
      },
      include: {
        ingredient: { select: { id: true, name: true, unit: true } },
      },
    })

    if (!existingPurchase) {
      return NextResponse.json({ error: 'Stock entry not found' }, { status: 404 })
    }

    if (hasConsumedPurchaseQuantity(existingPurchase)) {
      return NextResponse.json({ error: 'This stock entry has already been used by orders, so deleting is locked.' }, { status: 409 })
    }

    await prisma.$transaction(async (tx) => {
      const journalLink = await resolvePurchaseJournalPairId(tx, existingPurchase)
      if (!journalLink.pairId) {
        throw new Error(journalLink.resolution === 'ambiguous'
          ? 'This stock entry matches multiple accounting records and cannot be deleted safely.'
          : 'This stock entry is not linked to its accounting records, so deleting is blocked to keep reports correct.')
      }

      const deletedTransactions = await tx.transaction.deleteMany({
        where: {
          userId: billingUserId,
          restaurantId,
          branchId,
          pairId: journalLink.pairId,
          sourceKind: 'inventory_purchase',
        },
      })

      if (deletedTransactions.count === 0) {
        throw new Error('This stock entry is missing its accounting records, so deleting is blocked to keep reports correct.')
      }

      await tx.inventoryItem.update({
        where: { id: existingPurchase.ingredientId },
        data: {
          quantity: { decrement: existingPurchase.quantityPurchased },
        },
      })

      await tx.inventoryPurchase.delete({ where: { id } })

      const updatedIngredient = await syncIngredientActiveUnitCost(tx, {
        userId: billingUserId,
        restaurantId,
        branchId,
        ingredientId: existingPurchase.ingredientId,
      })
      if (!updatedIngredient) throw new Error('Ingredient not found after stock entry was deleted.')

      await enqueueSyncChange(tx, {
        restaurantId,
        branchId,
        entityType: 'inventoryPurchase',
        entityId: id,
        operation: 'delete',
        payload: { id },
      })

      await enqueueSyncChange(tx, {
        restaurantId,
        branchId,
        entityType: 'inventoryItem',
        entityId: updatedIngredient.id,
        operation: 'upsert',
        payload: updatedIngredient,
      })
    }, INVENTORY_TRANSACTION_OPTIONS)

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Failed to delete inventory purchase:', error)
    return NextResponse.json({ error: error?.message || 'Failed to delete inventory purchase', code: error?.code || null }, { status: 500 })
  }
}

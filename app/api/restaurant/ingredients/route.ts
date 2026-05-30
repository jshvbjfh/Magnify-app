import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { normalizeInventoryUnit } from '@/lib/inventoryUnits'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'
import { cached } from '@/lib/apiCache'

const PURCHASE_USAGE_EPSILON = 0.000001

function parseOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function resolveUsageUnit(unit?: string | null, fallbackUnit?: string | null) {
  const usageUnit = normalizeInventoryUnit(unit || fallbackUnit)
  if (!usageUnit) throw new Error('name and unit required')
  return usageUnit
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null

  if (!restaurantId || !branchId) return NextResponse.json([])

  const ingredients = await prisma.inventoryItem.findMany({
    where: { restaurantId, branchId },
    orderBy: { name: 'asc' },
  })
  return cached(ingredients)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null

  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { name, description, unit, unitCost, quantity, reorderLevel, category } = await req.json()
  if (!name || !unit) return NextResponse.json({ error: 'name and unit required' }, { status: 400 })

  let usageUnit: string
  try {
    usageUnit = resolveUsageUnit(unit)
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Invalid unit' }, { status: 400 })
  }

  try {
    const item = await prisma.inventoryItem.create({
      data: {
        restaurantId,
        branchId,
        name: String(name).trim(),
        description: description ? String(description).trim() : null,
        unit: usageUnit,
        unitCost: parseOptionalNumber(unitCost) ?? 0,
        quantity: parseOptionalNumber(quantity) ?? 0,
        reorderLevel: parseOptionalNumber(reorderLevel) ?? 0,
        category: category ? String(category).trim() : null,
      },
    })

    await enqueueSyncChange(prisma, {
      restaurantId,
      branchId,
      entityType: 'inventoryItem',
      entityId: item.id,
      operation: 'upsert',
      payload: item,
    })

    return NextResponse.json(item, { status: 201 })
  } catch (error: any) {
    if (error?.code === 'P2002') return NextResponse.json({ error: 'An ingredient with this name already exists' }, { status: 409 })
    return NextResponse.json({ error: error?.message || 'Failed to create ingredient' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null

  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { id, name, description, unit, unitCost, quantity, reorderLevel, category } = await req.json()

  if (!id) return NextResponse.json({ error: 'Ingredient id is required' }, { status: 400 })
  if (!name || !unit) return NextResponse.json({ error: 'name and unit required' }, { status: 400 })

  const existing = await prisma.inventoryItem.findFirst({
    where: { id, restaurantId, branchId },
  })

  if (!existing) return NextResponse.json({ error: 'Ingredient not found' }, { status: 404 })

  let usageUnit: string
  try {
    usageUnit = resolveUsageUnit(unit, existing.unit)
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Invalid unit' }, { status: 400 })
  }

  const usageUnitChanged = existing.unit.toLowerCase() !== usageUnit.toLowerCase()
  if (usageUnitChanged) {
    const openPurchaseCount = await prisma.inventoryPurchase.count({
      where: { restaurantId, branchId, ingredientId: existing.id, remainingQuantity: { gt: PURCHASE_USAGE_EPSILON } },
    })
    if (Number(existing.quantity || 0) > PURCHASE_USAGE_EPSILON || openPurchaseCount > 0) {
      return NextResponse.json(
        { error: 'This ingredient already has stock history. You cannot change the usage unit until existing stock is cleared.' },
        { status: 400 }
      )
    }
  }

  try {
    const item = await prisma.inventoryItem.update({
      where: { id },
      data: {
        name: String(name).trim(),
        description: description ? String(description).trim() : null,
        unit: usageUnit,
        unitCost: parseOptionalNumber(unitCost) ?? 0,
        quantity: parseOptionalNumber(quantity) ?? 0,
        reorderLevel: parseOptionalNumber(reorderLevel) ?? 0,
        category: category ? String(category).trim() : null,
      },
    })

    await enqueueSyncChange(prisma, {
      restaurantId,
      branchId,
      entityType: 'inventoryItem',
      entityId: item.id,
      operation: 'upsert',
      payload: item,
    })

    return NextResponse.json(item)
  } catch (error: any) {
    if (error?.code === 'P2002') return NextResponse.json({ error: 'An ingredient with this name already exists' }, { status: 409 })
    return NextResponse.json({ error: error?.message || 'Failed to update ingredient' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null

  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Ingredient id is required' }, { status: 400 })

  const existing = await prisma.inventoryItem.findFirst({ where: { id, restaurantId, branchId } })
  if (!existing) return NextResponse.json({ error: 'Ingredient not found' }, { status: 404 })

  try {
    await prisma.inventoryItem.delete({ where: { id } })

    await enqueueSyncChange(prisma, {
      restaurantId,
      branchId,
      entityType: 'inventoryItem',
      entityId: id,
      operation: 'delete',
      payload: { id },
    })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to delete ingredient' }, { status: 500 })
  }
}

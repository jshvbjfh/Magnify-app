import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { getRestaurantSharedStock } from '@/lib/inventoryConsumption'
import {
  InsufficientTransferStockError,
  getImportedStockForBranch,
  transferIngredientStock,
} from '@/lib/inventoryTransfer'

// Stock is money. Never serve it from a cache.
export const dynamic = 'force-dynamic'

/**
 * GET — what this station has already imported and not yet used up.
 *
 * This is the list the station works off during service, and the same numbers
 * the "imported stock used up" alert watches.
 */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const sessionBranchId = context?.branchId ?? null
  if (!restaurantId || !sessionBranchId) {
    return NextResponse.json({ error: 'No station found for this account.' }, { status: 400 })
  }

  const { searchParams } = new URL(req.url)
  const requestedBranchId = searchParams.get('branchId')?.trim() || null
  // Only a station of this restaurant, and only ever one that exists — an
  // unchecked id here would report another restaurant's stock.
  const branch = requestedBranchId
    ? await prisma.branch.findFirst({
        where: { id: requestedBranchId, restaurantId },
        select: { id: true },
      })
    : { id: sessionBranchId }
  if (!branch) return NextResponse.json({ error: 'Station not found.' }, { status: 403 })

  const imported = await getImportedStockForBranch(prisma, { restaurantId, branchId: branch.id })
  const stillHeld = new Set(imported.map((row) => row.ingredientId))

  // Anything this station imported that is now at zero. The station has fallen
  // back on the main store for it, which is exactly the moment whoever imported
  // wants to know — an item that simply vanished off the list would look like
  // the import had never happened.
  const everImported = await prisma.inventoryAdjustmentLog.findMany({
    where: { restaurantId, branchId: branch.id, adjustmentType: 'transfer_in' },
    select: { ingredientId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  const usedUpIds: string[] = []
  const lastImportedAt = new Map<string, Date>()
  for (const row of everImported) {
    if (!lastImportedAt.has(row.ingredientId)) lastImportedAt.set(row.ingredientId, row.createdAt)
    if (!stillHeld.has(row.ingredientId) && !usedUpIds.includes(row.ingredientId)) {
      usedUpIds.push(row.ingredientId)
    }
  }

  const referenced = Array.from(new Set([...stillHeld, ...usedUpIds]))
  if (referenced.length === 0) {
    return NextResponse.json({ branchId: branch.id, items: [], usedUp: [] })
  }

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: referenced }, restaurantId },
    select: { id: true, name: true, unit: true, category: true },
  })
  const byId = new Map(items.map((item) => [item.id, item]))
  const describe = (ingredientId: string) => ({
    ingredientId,
    name: byId.get(ingredientId)?.name ?? 'Unknown item',
    unit: byId.get(ingredientId)?.unit ?? '',
    category: byId.get(ingredientId)?.category ?? null,
    lastImportedAt: lastImportedAt.get(ingredientId) ?? null,
  })

  return NextResponse.json({
    branchId: branch.id,
    items: imported
      .map((row) => ({ ...describe(row.ingredientId), remaining: row.remaining }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    usedUp: usedUpIds
      .map(describe)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })
}

/**
 * POST — import stock from the main store onto a station.
 *
 * The station consumes what it imported before touching the shared pool, and
 * falls back to the pool once it is gone, so an import can never leave a
 * station unable to sell.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const sessionBranchId = context?.branchId ?? null
  if (!restaurantId || !sessionBranchId) {
    return NextResponse.json({ error: 'No station found for this account.' }, { status: 400 })
  }

  // Importing only makes sense against one shared pool. Without shared stock a
  // station already owns its stock outright and there is nothing to import from.
  const sharedStock = await getRestaurantSharedStock(prisma, restaurantId)
  if (!sharedStock) {
    return NextResponse.json(
      { error: 'This restaurant keeps stock per station, so there is no shared store to import from.' },
      { status: 400 },
    )
  }

  const body = await req.json().catch(() => null)
  const ingredientId = typeof body?.ingredientId === 'string' ? body.ingredientId.trim() : ''
  const quantity = Number(body?.quantity)
  const requestedBranchId = typeof body?.branchId === 'string' ? body.branchId.trim() : ''

  if (!ingredientId) return NextResponse.json({ error: 'Pick an item to import.' }, { status: 400 })
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: 'Enter how much to import.' }, { status: 400 })
  }

  const targetBranchId = requestedBranchId || sessionBranchId
  const branch = await prisma.branch.findFirst({
    where: { id: targetBranchId, restaurantId },
    select: { id: true, isMain: true },
  })
  if (!branch) return NextResponse.json({ error: 'Station not found.' }, { status: 403 })
  // The main station IS the shared store — importing to it would move stock
  // onto itself and split batches for nothing.
  if (branch.isMain) {
    return NextResponse.json(
      { error: 'The main store already holds this stock. Import to a station instead.' },
      { status: 400 },
    )
  }

  try {
    // One transaction: a partial move splits a batch across two rows, and a
    // failure between the two halves would leave stock that exists twice or
    // not at all.
    const result = await prisma.$transaction((tx) =>
      transferIngredientStock(tx, {
        restaurantId,
        toBranchId: branch.id,
        ingredientId,
        quantity,
        requestedByName: (session.user as { name?: string | null })?.name ?? null,
      }),
    )
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof InsufficientTransferStockError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    const message = error instanceof Error ? error.message : 'Import failed.'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

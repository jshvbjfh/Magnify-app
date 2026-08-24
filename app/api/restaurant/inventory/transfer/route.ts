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
  if (imported.length === 0) return NextResponse.json({ branchId: branch.id, items: [] })

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: imported.map((row) => row.ingredientId) }, restaurantId },
    select: { id: true, name: true, unit: true, category: true },
  })
  const byId = new Map(items.map((item) => [item.id, item]))

  return NextResponse.json({
    branchId: branch.id,
    items: imported
      .map((row) => ({
        ingredientId: row.ingredientId,
        name: byId.get(row.ingredientId)?.name ?? 'Unknown item',
        unit: byId.get(row.ingredientId)?.unit ?? '',
        category: byId.get(row.ingredientId)?.category ?? null,
        remaining: row.remaining,
      }))
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

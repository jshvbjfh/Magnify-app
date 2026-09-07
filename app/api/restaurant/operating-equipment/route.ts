import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { cached } from '@/lib/apiCache'

// Operating equipment — the non-food supplies a venue buys to run itself.
//
// Deliberately NOT wired into the sync outbox. Equipment is a manager-app
// concern: no waiter terminal orders soap and no kitchen screen needs to know
// how many mop sticks are left. Enqueuing it would create outbox rows that
// lib/syncEngine.ts has no handler for, which would retry eight times and then
// sit in the queue as permanent noise.

function parseOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function cleanText(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const { restaurantId, branchId } = context
  if (!restaurantId || !branchId) return NextResponse.json([])

  // Scoped to the signed-in station, same as stock. Equipment is physically
  // held somewhere — the soap in one kitchen's cupboard is not the other's —
  // and there is no shared-pool switch for it the way there is for ingredients.
  const items = await prisma.operatingEquipment.findMany({
    where: { restaurantId, branchId, deletedAt: null },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  })
  return cached(items)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const { restaurantId, branchId } = context
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant station found' }, { status: 400 })

  const body = await req.json()
  const name = cleanText(body?.name)
  if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  const openingQuantity = parseOptionalNumber(body?.quantity) ?? 0
  const unitCost = parseOptionalNumber(body?.unitCost) ?? 0

  try {
    // An opening count is recorded as an adjustment rather than written straight
    // onto the row, so the ledger explains every unit on the shelf from day one.
    // Without it the first stock take reads as an unexplained gain.
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.operatingEquipment.create({
        data: {
          restaurantId,
          branchId,
          name,
          unit: cleanText(body?.unit) || 'piece',
          quantity: openingQuantity,
          unitCost,
          reorderLevel: parseOptionalNumber(body?.reorderLevel) ?? 0,
          category: cleanText(body?.category),
          notes: cleanText(body?.notes),
        },
      })

      if (openingQuantity !== 0) {
        await tx.operatingEquipmentMovement.create({
          data: {
            equipmentId: created.id,
            restaurantId,
            branchId,
            kind: 'adjustment',
            quantity: openingQuantity,
            unitCost,
            totalCost: unitCost * openingQuantity,
            note: 'Opening count',
            recordedBy: cleanText(body?.recordedBy),
          },
        })
      }

      return created
    })

    return NextResponse.json(item, { status: 201 })
  } catch (error: any) {
    if (error?.code === 'P2002') return NextResponse.json({ error: 'An item with this name already exists' }, { status: 409 })
    return NextResponse.json({ error: error?.message || 'Failed to create item' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const { restaurantId, branchId } = context
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant station found' }, { status: 400 })

  const body = await req.json()
  const id = typeof body?.id === 'string' ? body.id : null
  if (!id) return NextResponse.json({ error: 'Item id is required' }, { status: 400 })

  const name = cleanText(body?.name)
  if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  const existing = await prisma.operatingEquipment.findFirst({
    where: { id, restaurantId, branchId, deletedAt: null },
  })
  if (!existing) return NextResponse.json({ error: 'Item not found' }, { status: 404 })

  try {
    // Quantity is intentionally not editable here. It only ever moves through
    // the movements ledger, so that the number on screen always has a recorded
    // reason behind it — an edit box would let stock change with no trace.
    const item = await prisma.operatingEquipment.update({
      where: { id },
      data: {
        name,
        unit: cleanText(body?.unit) || existing.unit,
        unitCost: parseOptionalNumber(body?.unitCost) ?? existing.unitCost,
        reorderLevel: parseOptionalNumber(body?.reorderLevel) ?? existing.reorderLevel,
        category: cleanText(body?.category),
        notes: cleanText(body?.notes),
        ...(typeof body?.isActive === 'boolean' ? { isActive: body.isActive } : {}),
      },
    })
    return NextResponse.json(item)
  } catch (error: any) {
    if (error?.code === 'P2002') return NextResponse.json({ error: 'An item with this name already exists' }, { status: 409 })
    return NextResponse.json({ error: error?.message || 'Failed to update item' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const { restaurantId, branchId } = context
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant station found' }, { status: 400 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Item id is required' }, { status: 400 })

  const existing = await prisma.operatingEquipment.findFirst({
    where: { id, restaurantId, branchId, deletedAt: null },
  })
  if (!existing) return NextResponse.json({ error: 'Item not found' }, { status: 404 })

  try {
    // Soft delete: the movement history stays readable, and a name freed this
    // way can be reused because the unique index still counts the old row —
    // so the name is stamped to keep the index honest without losing it.
    await prisma.operatingEquipment.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, name: `${existing.name} (removed ${Date.now()})` },
    })
    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to remove item' }, { status: 500 })
  }
}

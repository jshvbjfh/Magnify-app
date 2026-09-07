import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import {
  applyMovement,
  isMovementKind,
  nextUnitCost,
  normalizeEquipmentName,
  sanitizeEquipmentName,
} from '@/lib/operatingEquipment'

// Every change to an equipment quantity goes through here. Nothing else writes
// OperatingEquipment.quantity, so the number on screen and the ledger behind it
// can never disagree. The arithmetic itself lives in lib/operatingEquipment.ts
// so it can be tested without a session or a database.

function parseOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function cleanText(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const { restaurantId, branchId } = context
  if (!restaurantId || !branchId) return NextResponse.json([])

  const { searchParams } = new URL(req.url)
  const equipmentId = searchParams.get('equipmentId')
  const limit = Math.min(Number(searchParams.get('limit')) || 200, 500)

  const movements = await prisma.operatingEquipmentMovement.findMany({
    where: {
      restaurantId,
      branchId,
      deletedAt: null,
      ...(equipmentId ? { equipmentId } : {}),
    },
    include: { equipment: { select: { id: true, name: true, unit: true } } },
    orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  })
  return NextResponse.json(movements)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const { restaurantId, branchId } = context
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant station found' }, { status: 400 })

  const body = await req.json()
  // Either address an item by id, or name it. Naming is how the delivery
  // recorder works: a line is typed, and whether that item already exists is
  // the server's problem, not something the person recording has to know.
  const equipmentId = typeof body?.equipmentId === 'string' ? body.equipmentId : null
  const typedName = sanitizeEquipmentName(typeof body?.itemName === 'string' ? body.itemName : '')
  if (!equipmentId && !typedName) return NextResponse.json({ error: 'Item is required' }, { status: 400 })

  if (!isMovementKind(body?.kind)) {
    return NextResponse.json({ error: 'Choose received, issued, or correction' }, { status: 400 })
  }
  const kind = body.kind

  const rawQuantity = parseOptionalNumber(body?.quantity)
  if (rawQuantity === null) return NextResponse.json({ error: 'Enter a quantity' }, { status: 400 })

  const occurredAtRaw = cleanText(body?.occurredAt)
  const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date()
  if (Number.isNaN(occurredAt.getTime())) {
    return NextResponse.json({ error: 'That date is not valid' }, { status: 400 })
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      let item = equipmentId
        ? await tx.operatingEquipment.findFirst({
            where: { id: equipmentId, restaurantId, branchId, deletedAt: null },
          })
        : null

      // Match on the normalised name so a difference in capitalisation or
      // spacing joins the existing item instead of quietly starting a second
      // one and splitting the stock level in two.
      if (!item && typedName) {
        const candidates = await tx.operatingEquipment.findMany({
          where: { restaurantId, branchId, deletedAt: null },
        })
        const target = normalizeEquipmentName(typedName)
        item = candidates.find((row) => normalizeEquipmentName(row.name) === target) ?? null
      }

      let createdItem = false
      if (!item) {
        if (!typedName) throw Object.assign(new Error('Item not found'), { status: 404 })
        // A name nobody has used before is a new item. Created at zero and then
        // moved by the same ledger entry as everything else, so even its first
        // unit has a recorded reason behind it.
        item = await tx.operatingEquipment.create({
          data: {
            restaurantId,
            branchId,
            name: typedName,
            unit: cleanText(body?.unit) || 'piece',
            category: cleanText(body?.category),
            quantity: 0,
            unitCost: 0,
            reorderLevel: parseOptionalNumber(body?.reorderLevel) ?? 0,
          },
        })
        createdItem = true
      } else if (cleanText(body?.unit) && cleanText(body?.unit) !== item.unit && Number(item.quantity) === 0) {
        // An empty shelf can change its unit freely; stock on hand cannot,
        // because the number already counted is expressed in the old one.
        item = await tx.operatingEquipment.update({
          where: { id: item.id },
          data: { unit: cleanText(body?.unit)! },
        })
      }

      const equipmentIdResolved = item.id

      const outcome = applyMovement({
        kind,
        rawQuantity,
        currentQuantity: Number(item.quantity),
        unit: item.unit,
      })
      if (!outcome.ok) throw Object.assign(new Error(outcome.error), { status: 400 })
      const { delta, nextQuantity } = outcome

      const submittedUnitCost = parseOptionalNumber(body?.unitCost)
      const resolvedUnitCost = nextUnitCost({
        kind,
        submittedUnitCost,
        currentUnitCost: Number(item.unitCost),
      })
      // Every movement is valued, not just the purchases: a purchase at what was
      // actually paid, an issue or a correction at the standing price. Booking a
      // zero on the way out would make the ledger say a cupboard's worth of soap
      // left the building for nothing.
      const movement = await tx.operatingEquipmentMovement.create({
        data: {
          equipmentId: equipmentIdResolved,
          restaurantId,
          branchId,
          kind,
          batchId: cleanText(body?.batchId),
          quantity: delta,
          unitCost: resolvedUnitCost,
          totalCost: resolvedUnitCost * Math.abs(delta),
          supplier: cleanText(body?.supplier),
          note: cleanText(body?.note),
          recordedBy: cleanText(body?.recordedBy),
          occurredAt,
        },
      })

      const updated = await tx.operatingEquipment.update({
        where: { id: equipmentIdResolved },
        data: { quantity: nextQuantity, unitCost: resolvedUnitCost },
      })

      return { movement, item: updated, createdItem }
    })

    return NextResponse.json(result, { status: 201 })
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500
    return NextResponse.json({ error: error?.message || 'Failed to record movement' }, { status })
  }
}

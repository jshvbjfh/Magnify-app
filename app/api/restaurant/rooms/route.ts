import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'

// Rooms are restaurant-wide, exactly as the floor plan is. A hotel's kitchen,
// bar and reception are stations of one property, and a guest charged to room
// 204 has to resolve to the same room whichever station took the order — so
// these routes match on restaurantId alone and never on the signed-in branch.
//
// There is deliberately no sync enqueue here yet. Tables sync because the
// waiter app draws the floor plan; nothing in the waiter app reads rooms until
// charge-to-room exists, and shipping a sync channel with no reader would only
// be a channel to keep working.

const ROOM_STATUSES = ['vacant', 'occupied', 'dirty', 'maintenance'] as const
type RoomStatus = (typeof ROOM_STATUSES)[number]

function isRoomStatus(value: unknown): value is RoomStatus {
  return typeof value === 'string' && (ROOM_STATUSES as readonly string[]).includes(value)
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId) return NextResponse.json([])

  const rooms = await prisma.room.findMany({
    where: { restaurantId: context.restaurantId, deletedAt: null },
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(rooms)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId || !context.branchId) {
    return NextResponse.json({ error: 'No restaurant station found' }, { status: 400 })
  }

  const body = await req.json()
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'Room number required' }, { status: 400 })

  // Rate and capacity are typed by a manager, so guard the parse rather than
  // trusting Number() — an empty box would otherwise store NaN and every screen
  // reading it would print "NaN" forever.
  const capacity = Number(body?.capacity)
  const rate = Number(body?.rate)

  try {
    // branchId is origin metadata only — the room is shared by every station.
    const room = await prisma.room.create({
      data: {
        restaurantId: context.restaurantId,
        branchId: context.branchId,
        name,
        type: typeof body?.type === 'string' && body.type.trim() ? body.type.trim() : 'double',
        capacity: Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 2,
        rate: Number.isFinite(rate) && rate > 0 ? rate : 0,
        status: isRoomStatus(body?.status) ? body.status : 'vacant',
        floor: typeof body?.floor === 'string' && body.floor.trim() ? body.floor.trim() : null,
        notes: typeof body?.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
      },
    })
    return NextResponse.json(room, { status: 201 })
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'P2002') {
      return NextResponse.json({ error: `Room ${name} already exists` }, { status: 409 })
    }
    throw error
  }
}

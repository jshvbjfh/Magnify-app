import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'

const ROOM_STATUSES = ['vacant', 'occupied', 'dirty', 'maintenance'] as const
type RoomStatus = (typeof ROOM_STATUSES)[number]

function isRoomStatus(value: unknown): value is RoomStatus {
  return typeof value === 'string' && (ROOM_STATUSES as readonly string[]).includes(value)
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId) return NextResponse.json({ error: 'No restaurant' }, { status: 400 })

  const { id } = await params
  const body = await req.json()

  const data: Record<string, unknown> = {}
  if (body?.status !== undefined) {
    if (!isRoomStatus(body.status)) return NextResponse.json({ error: 'Unknown room status' }, { status: 400 })
    data.status = body.status
  }
  if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim()
  if (typeof body?.type === 'string' && body.type.trim()) data.type = body.type.trim()
  if (body?.capacity !== undefined) {
    const capacity = Number(body.capacity)
    if (!Number.isFinite(capacity) || capacity <= 0) return NextResponse.json({ error: 'Capacity must be a number' }, { status: 400 })
    data.capacity = Math.floor(capacity)
  }
  if (body?.rate !== undefined) {
    const rate = Number(body.rate)
    if (!Number.isFinite(rate) || rate < 0) return NextResponse.json({ error: 'Rate must be a number' }, { status: 400 })
    data.rate = rate
  }
  if (body?.floor !== undefined) data.floor = typeof body.floor === 'string' && body.floor.trim() ? body.floor.trim() : null
  if (body?.notes !== undefined) data.notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null

  if (Object.keys(data).length === 0) return NextResponse.json({ ok: true, count: 0 })

  // Rooms are restaurant-wide, so match by restaurant only — any station may edit.
  try {
    const result = await prisma.room.updateMany({
      where: { id, restaurantId: context.restaurantId, deletedAt: null },
      data,
    })
    return NextResponse.json({ ok: true, count: result.count })
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'P2002') {
      return NextResponse.json({ error: `Room ${data.name} already exists` }, { status: 409 })
    }
    throw error
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId) return NextResponse.json({ error: 'No restaurant' }, { status: 400 })

  const { id } = await params

  // Soft delete, unlike tables, which delete outright. A room that has held
  // guests will eventually have bills pointing at it, and a hard delete would
  // leave those bills naming a room nobody can look up. The unique index is on
  // name, though, so a soft-deleted 204 would block a new 204 — release the
  // name by stamping the deletion onto it.
  const room = await prisma.room.findFirst({
    where: { id, restaurantId: context.restaurantId, deletedAt: null },
    select: { name: true },
  })
  if (!room) return NextResponse.json({ ok: true, count: 0 })

  const deletedAt = new Date()
  await prisma.room.updateMany({
    where: { id, restaurantId: context.restaurantId },
    data: { deletedAt, isActive: false, name: `${room.name} (deleted ${deletedAt.toISOString().slice(0, 10)})` },
  })
  return NextResponse.json({ ok: true, count: 1 })
}

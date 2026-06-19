import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { enqueueRestaurantTableDeleteSync, enqueueRestaurantTableSync } from '@/lib/restaurantTableSync'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId) return NextResponse.json({ error: 'No restaurant' }, { status: 400 })

  const { id } = await params
  const { status, name, seats } = await req.json()

  // Tables are restaurant-wide, so match by restaurant only — any branch may edit.
  try {
    const table = await prisma.restaurantTable.updateMany({
      where: { id, restaurantId: context.restaurantId },
      data: {
        ...(status !== undefined && { status }),
        ...(name !== undefined && { name }),
        ...(seats !== undefined && { seats: Number(seats) }),
      }
    })
    if (table.count > 0) {
      await enqueueRestaurantTableSync(prisma, id, context.restaurantId)
    }
    return NextResponse.json({ ok: true, count: table.count })
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'P2002') {
      return NextResponse.json({ error: `Table "${name}" already exists` }, { status: 409 })
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
  // Tables are restaurant-wide — delete removes it for every branch.
  const existing = await prisma.restaurantTable.findFirst({ where: { id, restaurantId: context.restaurantId }, select: { branchId: true } })
  await prisma.restaurantTable.deleteMany({ where: { id, restaurantId: context.restaurantId } })
  if (existing) {
    await enqueueRestaurantTableDeleteSync(prisma, { tableId: id, restaurantId: context.restaurantId, branchId: existing.branchId })
  }
  return NextResponse.json({ ok: true })
}

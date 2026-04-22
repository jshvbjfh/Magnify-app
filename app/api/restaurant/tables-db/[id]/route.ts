import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueRestaurantTableDeleteSync, enqueueRestaurantTableSync } from '@/lib/restaurantTableSync'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch' }, { status: 400 })

  const { id } = await params
  const { status, name, seats } = await req.json()

  const table = await prisma.restaurantTable.updateMany({
    where: { id, restaurantId: context.restaurantId, branchId: context.branchId },
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
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch' }, { status: 400 })

  const { id } = await params
  const existing = await prisma.restaurantTable.findFirst({ where: { id, restaurantId: context.restaurantId, branchId: context.branchId }, select: { id: true } })
  await prisma.restaurantTable.deleteMany({ where: { id, restaurantId: context.restaurantId, branchId: context.branchId } })
  if (existing) {
    await enqueueRestaurantTableDeleteSync(prisma, { tableId: id, restaurantId: context.restaurantId, branchId: context.branchId })
  }
  return NextResponse.json({ ok: true })
}

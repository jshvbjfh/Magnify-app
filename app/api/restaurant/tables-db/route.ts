import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueRestaurantTableSync } from '@/lib/restaurantTableSync'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json([])

  const tables = await prisma.restaurantTable.findMany({
    where: { restaurantId: context.restaurantId, branchId: context.branchId },
    orderBy: { createdAt: 'asc' }
  })
  return NextResponse.json(tables)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { name, seats, status } = await req.json()
  if (!name?.trim()) return NextResponse.json({ error: 'Name required' }, { status: 400 })

  const table = await prisma.restaurantTable.create({
    data: { restaurantId: context.restaurantId, branchId: context.branchId, name: name.trim(), seats: Number(seats) || 4, status: status || 'available' }
  })
  await enqueueRestaurantTableSync(prisma, table.id, context.restaurantId)
  return NextResponse.json(table, { status: 201 })
}

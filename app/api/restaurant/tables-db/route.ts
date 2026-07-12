import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { enqueueRestaurantTableSync } from '@/lib/restaurantTableSync'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId) return NextResponse.json([])

  // Tables are restaurant-wide — every branch sees the same floor plan.
  const tables = await prisma.restaurantTable.findMany({
    where: { restaurantId: context.restaurantId },
    orderBy: { createdAt: 'asc' }
  })
  return NextResponse.json(tables)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant station found' }, { status: 400 })

  const { name, seats, status } = await req.json()
  if (!name?.trim()) return NextResponse.json({ error: 'Name required' }, { status: 400 })

  // branchId is kept as origin metadata only — the table is shared by all branches.
  try {
    const table = await prisma.restaurantTable.create({
      data: { restaurantId: context.restaurantId, branchId: context.branchId, name: name.trim(), seats: Number(seats) || 4, status: status || 'available' }
    })
    await enqueueRestaurantTableSync(prisma, table.id, context.restaurantId)
    return NextResponse.json(table, { status: 201 })
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'P2002') {
      return NextResponse.json({ error: `Table "${name.trim()}" already exists` }, { status: 409 })
    }
    throw error
  }
}

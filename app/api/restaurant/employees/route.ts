import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null

  if (!restaurantId || !branchId) return NextResponse.json([])

  const staff = await prisma.staff.findMany({
    where: {
      restaurantId,
      branches: { some: { branchId } },
      deletedAt: null,
    },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      role: true,
      isActive: true,
      phone: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return NextResponse.json(staff)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const ALLOWED_ROLES = ['waiter', 'kitchen']

  const { name, role, phone } = await req.json()
  if (!name || !role) {
    return NextResponse.json({ error: 'name and role are required' }, { status: 400 })
  }
  if (!ALLOWED_ROLES.includes(String(role).toLowerCase())) {
    return NextResponse.json({ error: `Invalid role. Allowed roles: ${ALLOWED_ROLES.join(', ')}` }, { status: 400 })
  }

  const staff = await prisma.staff.create({
    data: {
      restaurantId: context.restaurantId,
      name,
      role,
      phone: phone || null,
      branches: {
        create: { branchId: context.branchId },
      },
    },
    select: {
      id: true,
      name: true,
      role: true,
      isActive: true,
      phone: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    entityType: 'staff',
    entityId: staff.id,
    operation: 'upsert',
    payload: staff,
  })

  return NextResponse.json(staff, { status: 201 })
}

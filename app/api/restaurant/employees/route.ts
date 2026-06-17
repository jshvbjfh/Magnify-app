import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'
import { cached } from '@/lib/apiCache'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null

  if (!restaurantId || !branchId) return NextResponse.json([])

  const staff = await prisma.staff.findMany({
    where: {
      restaurantId,
      branches: { some: { branchId } },
      deletedAt: null,
      username: null, // exclude waiter/kitchen login accounts; employees have no login credentials
    },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      role: true,
      isActive: true,
      phone: true,
      pin: true,
      cancellationPin: true,
      hourlyRate: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return cached(staff.map(s => ({
    ...s,
    hasPin: s.pin !== null,
    hasCancellationPin: s.cancellationPin !== null,
    pin: undefined,
    cancellationPin: undefined,
  })))
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const ALLOWED_ROLES = ['Chef', 'Sous Chef', 'Waiter', 'Cashier', 'Manager', 'Host', 'Dishwasher', 'Bartender']

  const { name, role, phone, hourlyRate } = await req.json()
  if (!name || !role) {
    return NextResponse.json({ error: 'name and role are required' }, { status: 400 })
  }
  if (!ALLOWED_ROLES.some(r => r.toLowerCase() === String(role).toLowerCase())) {
    return NextResponse.json({ error: `Invalid role. Allowed roles: ${ALLOWED_ROLES.join(', ')}` }, { status: 400 })
  }

  let rate: number | null = null
  if (hourlyRate !== undefined && hourlyRate !== null && hourlyRate !== '') {
    rate = Number(hourlyRate)
    if (Number.isNaN(rate) || rate < 0) {
      return NextResponse.json({ error: 'Hourly rate must be a positive number' }, { status: 400 })
    }
  }

  const staff = await prisma.staff.create({
    data: {
      restaurantId: context.restaurantId,
      name,
      role,
      phone: phone || null,
      hourlyRate: rate,
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
      hourlyRate: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  const staffWithFlags = { ...staff, hasPin: false, hasCancellationPin: false }

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    entityType: 'staff',
    entityId: staffWithFlags.id,
    operation: 'upsert',
    payload: staffWithFlags,
  })

  return NextResponse.json(staffWithFlags, { status: 201 })
}

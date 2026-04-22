import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { hashCancellationPin, isValidCancellationPin } from '@/lib/cancelApproval'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  const billingUserId = context?.billingUserId ?? session.user.id
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null

  if (!restaurantId || !branchId) return NextResponse.json([])

  const employees = await prisma.employee.findMany({
    where: { userId: billingUserId, restaurantId, branchId },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      role: true,
      payType: true,
      payRate: true,
      isActive: true,
      canApproveOrderCancellation: true,
      phone: true,
      createdAt: true,
      updatedAt: true,
    }
  })
  return NextResponse.json(employees)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { name, role, payType, payRate, phone, canApproveOrderCancellation, cancellationPin } = await req.json()
  if (!name || !role || !payType || payRate == null) {
    return NextResponse.json({ error: 'name, role, payType, payRate required' }, { status: 400 })
  }

  const canApprove = Boolean(canApproveOrderCancellation)
  const normalizedPin = String(cancellationPin || '').trim()
  if (canApprove && !isValidCancellationPin(normalizedPin)) {
    return NextResponse.json({ error: 'Cancellation PIN must be exactly 5 digits' }, { status: 400 })
  }

  const employee = await prisma.employee.create({
    data: {
      userId: context.billingUserId,
      restaurantId: context.restaurantId,
      branchId: context.branchId,
      name,
      role,
      payType,
      payRate: Number(payRate),
      phone: phone || null,
      canApproveOrderCancellation: canApprove,
      cancellationPinHash: canApprove ? await hashCancellationPin(normalizedPin) : null,
    },
    select: {
      id: true,
      name: true,
      role: true,
      payType: true,
      payRate: true,
      isActive: true,
      canApproveOrderCancellation: true,
      phone: true,
      createdAt: true,
      updatedAt: true,
    }
  })

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    entityType: 'employee',
    entityId: employee.id,
    operation: 'upsert',
    payload: employee,
  })

  return NextResponse.json(employee, { status: 201 })
}

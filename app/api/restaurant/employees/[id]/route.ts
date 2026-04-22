import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { hashCancellationPin, isValidCancellationPin } from '@/lib/cancelApproval'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { id } = await params
  const data = await req.json()

  const updateData: Record<string, unknown> = {
    ...(data.name !== undefined && { name: data.name }),
    ...(data.role !== undefined && { role: data.role }),
    ...(data.payType !== undefined && { payType: data.payType }),
    ...(data.payRate !== undefined && { payRate: Number(data.payRate) }),
    ...(data.phone !== undefined && { phone: data.phone }),
    ...(data.isActive !== undefined && { isActive: data.isActive }),
  }

  if (data.canApproveOrderCancellation !== undefined) {
    const canApprove = Boolean(data.canApproveOrderCancellation)
    updateData.canApproveOrderCancellation = canApprove
    if (!canApprove) {
      updateData.cancellationPinHash = null
    }
  }

  if (data.cancellationPin !== undefined) {
    const normalizedPin = String(data.cancellationPin || '').trim()
    if (!normalizedPin) {
      updateData.cancellationPinHash = null
      updateData.canApproveOrderCancellation = false
    } else {
      if (!isValidCancellationPin(normalizedPin)) {
        return NextResponse.json({ error: 'Cancellation PIN must be exactly 5 digits' }, { status: 400 })
      }
      updateData.cancellationPinHash = await hashCancellationPin(normalizedPin)
      updateData.canApproveOrderCancellation = true
    }
  }

  await prisma.employee.updateMany({
    where: { id, userId: context.billingUserId, restaurantId: context.restaurantId, branchId: context.branchId },
    data: updateData,
  })

  const employee = await prisma.employee.findFirst({ where: { id, userId: context.billingUserId, restaurantId: context.restaurantId, branchId: context.branchId } })
  if (employee) {
    await enqueueSyncChange(prisma, {
      restaurantId: context.restaurantId,
      branchId: context.branchId,
      entityType: 'employee',
      entityId: employee.id,
      operation: 'upsert',
      payload: employee,
    })
  }

  return NextResponse.json({ success: true })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { id } = await params
  const employee = await prisma.employee.findFirst({ where: { id, userId: context.billingUserId, restaurantId: context.restaurantId, branchId: context.branchId } })
  await prisma.employee.deleteMany({ where: { id, userId: context.billingUserId, restaurantId: context.restaurantId, branchId: context.branchId } })

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    entityType: 'employee',
    entityId: id,
    operation: 'delete',
    payload: employee ? { id: employee.id } : { id },
  })

  return NextResponse.json({ success: true })
}

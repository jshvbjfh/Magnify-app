import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { parseSubscriptionExpiryInput } from '@/lib/subscriptions'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { isActive, subscriptionPlan, subscriptionExpiry } = body

  const nextExpiry = subscriptionExpiry !== undefined
    ? (subscriptionExpiry ? parseSubscriptionExpiryInput(subscriptionExpiry) : null)
    : undefined

  const data: Record<string, unknown> = {}
  if (typeof isActive === 'boolean') data.isActive = isActive
  if (subscriptionPlan !== undefined) data.subscriptionPlan = subscriptionPlan
  if (nextExpiry !== undefined) {
    data.subscriptionExpiry = nextExpiry
    if (nextExpiry) data.subscriptionActivatedAt = new Date()
  }

  const user = await prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { id: params.id },
      data,
      select: {
        id: true,
        isActive: true,
        subscriptionPlan: true,
        subscriptionActivatedAt: true,
        subscriptionExpiry: true,
      },
    })

    const restaurantData: Record<string, unknown> = {}
    if (typeof isActive === 'boolean') restaurantData.licenseActive = isActive
    if (nextExpiry !== undefined) restaurantData.licenseExpiry = nextExpiry

    if (Object.keys(restaurantData).length > 0) {
      await tx.restaurant.updateMany({
        where: { ownerId: params.id },
        data: restaurantData,
      })
    }

    return updatedUser
  })

  return NextResponse.json(user)
}

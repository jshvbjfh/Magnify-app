import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { endOfDay, getDaysOverdue, getDaysRemaining, startOfDay } from '@/lib/subscriptions'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const now = new Date()
  const today = startOfDay(now)
  const in7Days = endOfDay(new Date(today.getTime() + 7 * 86400000))

  const [expiredRestaurants, expiringSoonRestaurants] = await Promise.all([
    prisma.restaurant.findMany({
      where: {
        owner: {
          subscriptionExpiry: { lt: today },
        },
      },
      select: {
        id: true,
        name: true,
        owner: {
          select: {
            id: true,
            isActive: true,
            subscriptionPlan: true,
            subscriptionActivatedAt: true,
            subscriptionExpiry: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    }),
    prisma.restaurant.findMany({
      where: {
        owner: {
          subscriptionExpiry: {
            gte: today,
            lte: in7Days,
          },
        },
      },
      select: {
        id: true,
        name: true,
        owner: {
          select: {
            id: true,
            isActive: true,
            subscriptionPlan: true,
            subscriptionActivatedAt: true,
            subscriptionExpiry: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    }),
  ])

  const expired = expiredRestaurants
    .filter((restaurant) => restaurant.owner.subscriptionExpiry)
    .map((restaurant) => ({
      userId: restaurant.owner.id,
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      plan: restaurant.owner.subscriptionPlan,
      subscriptionActivatedAt: restaurant.owner.subscriptionActivatedAt,
      subscriptionExpiry: restaurant.owner.subscriptionExpiry,
      daysOverdue: getDaysOverdue(restaurant.owner.subscriptionExpiry!, now),
      isActive: restaurant.owner.isActive,
    }))

  const expiringSoon = expiringSoonRestaurants
    .filter((restaurant) => restaurant.owner.subscriptionExpiry)
    .map((restaurant) => ({
      userId: restaurant.owner.id,
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      plan: restaurant.owner.subscriptionPlan,
      subscriptionActivatedAt: restaurant.owner.subscriptionActivatedAt,
      subscriptionExpiry: restaurant.owner.subscriptionExpiry,
      daysRemaining: getDaysRemaining(restaurant.owner.subscriptionExpiry!, now),
      isActive: restaurant.owner.isActive,
    }))

  return NextResponse.json({ expired, expiringSoon })
}
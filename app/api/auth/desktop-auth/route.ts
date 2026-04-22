import { NextRequest, NextResponse } from 'next/server'
import { compare } from 'bcryptjs'

import { prisma } from '@/lib/prisma'
import { findOwnedRestaurant } from '@/lib/restaurantAccess'

async function resolveLinkedRestaurant(user: { id: string; role: string; restaurantId: string | null }) {
  if (user.role === 'admin' || user.role === 'owner') {
    const linkedRestaurant = await findOwnedRestaurant(user.id)
    if (linkedRestaurant) {
      return prisma.restaurant.findUnique({
        where: { id: linkedRestaurant.id },
        select: {
          id: true,
          name: true,
          joinCode: true,
          qrOrderingMode: true,
          licenseActive: true,
          licenseExpiry: true,
          syncRestaurantId: true,
          syncToken: true,
          owner: {
            select: {
              name: true,
              email: true,
              role: true,
              businessType: true,
              trackingMode: true,
              isActive: true,
            },
          },
        },
      })
    }
  }

  if (!user.restaurantId) return null

  return prisma.restaurant.findUnique({
    where: { id: user.restaurantId },
    select: {
      id: true,
      name: true,
      joinCode: true,
      qrOrderingMode: true,
      licenseActive: true,
      licenseExpiry: true,
      syncRestaurantId: true,
      syncToken: true,
      owner: {
        select: {
          name: true,
          email: true,
          role: true,
          businessType: true,
          trackingMode: true,
          isActive: true,
        },
      },
    },
  })
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 })
  }

  const ok = await compare(password, user.password)
  if (!ok) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 })
  }

  if (!user.isActive && !user.isSuperAdmin) {
    return NextResponse.json({ error: 'AccountInactive' }, { status: 403 })
  }

  const restaurant = await resolveLinkedRestaurant({
    id: user.id,
    role: user.role,
    restaurantId: user.restaurantId ?? null,
  })

  return NextResponse.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      businessType: user.businessType ?? 'restaurant',
      trackingMode: (user as any).trackingMode ?? 'simple',
      isActive: user.isActive,
      isSuperAdmin: user.isSuperAdmin,
      subscriptionPlan: user.subscriptionPlan,
      subscriptionActivatedAt: user.subscriptionActivatedAt?.toISOString() ?? null,
      subscriptionExpiry: user.subscriptionExpiry?.toISOString() ?? null,
    },
    restaurant: restaurant ? {
      id: restaurant.id,
      name: restaurant.name,
      joinCode: restaurant.joinCode,
      qrOrderingMode: restaurant.qrOrderingMode,
      licenseActive: restaurant.licenseActive,
      licenseExpiry: restaurant.licenseExpiry?.toISOString() ?? null,
      syncRestaurantId: restaurant.syncRestaurantId ?? null,
      syncToken: restaurant.syncToken ?? null,
      owner: restaurant.owner ? {
        name: restaurant.owner.name,
        email: restaurant.owner.email,
        role: restaurant.owner.role,
        businessType: restaurant.owner.businessType ?? 'restaurant',
        trackingMode: restaurant.owner.trackingMode ?? 'simple',
        isActive: restaurant.owner.isActive,
      } : null,
    } : null,
  })
}
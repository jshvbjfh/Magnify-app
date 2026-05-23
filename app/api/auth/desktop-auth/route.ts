import { NextRequest, NextResponse } from 'next/server'
import { compare } from 'bcryptjs'

import { prisma } from '@/lib/prisma'
import { findOwnedRestaurant } from '@/lib/restaurantAccess'

async function resolveLinkedRestaurant(userId: string, role: string) {
  if (role === 'admin' || role === 'owner') {
    const linkedRestaurant = await findOwnedRestaurant(userId)
    if (linkedRestaurant) {
      return prisma.restaurant.findUnique({
        where: { id: linkedRestaurant.id },
        select: {
          id: true,
          name: true,
          joinCode: true,
          syncRestaurantId: true,
          licenseActive: true,
          licenseExpiry: true,
          owner: {
            select: {
              name: true,
              email: true,
              role: true,
              isActive: true,
            },
          },
        },
      })
    }
  }

  return null
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

  const restaurant = await resolveLinkedRestaurant(user.id, user.role)

  return NextResponse.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      isSuperAdmin: user.isSuperAdmin,
    },
    restaurant: restaurant ? {
      id: restaurant.id,
      name: restaurant.name,
      joinCode: restaurant.joinCode,
      syncRestaurantId: restaurant.syncRestaurantId,
      licenseActive: restaurant.licenseActive,
      licenseExpiry: restaurant.licenseExpiry?.toISOString() ?? null,
      owner: restaurant.owner ? {
        name: restaurant.owner.name,
        email: restaurant.owner.email,
        role: restaurant.owner.role,
        isActive: restaurant.owner.isActive,
      } : null,
    } : null,
  })
}

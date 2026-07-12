import { NextResponse } from 'next/server'
import { compare } from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import type { OwnerSyncSnapshot } from '@/lib/ownerSync'

async function resolveRestaurantForUser(user: { id: string; role: string }) {
  if (user.role === 'admin') {
    return prisma.restaurant.findFirst({
      where: { managerId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    })
  }

  if (user.role === 'owner') {
    return prisma.restaurant.findFirst({
      where: { ownerId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    })
  }

  return null
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    const snapshot = body.snapshot as OwnerSyncSnapshot | undefined

    if (!email || !password || !snapshot) {
      return NextResponse.json({ error: 'email, password, and snapshot are required' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) return NextResponse.json({ error: 'Invalid sync credentials' }, { status: 401 })

    const passwordOk = await compare(password, user.password)
    if (!passwordOk) return NextResponse.json({ error: 'Invalid sync credentials' }, { status: 401 })

    const restaurant = await resolveRestaurantForUser({ id: user.id, role: user.role })
    if (!restaurant) {
      return NextResponse.json({ error: 'No restaurant is linked to these sync credentials' }, { status: 403 })
    }

    return NextResponse.json({ ok: true, syncedAt: snapshot.generatedAt, restaurantId: restaurant.id })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to import station snapshot' },
      { status: 500 }
    )
  }
}

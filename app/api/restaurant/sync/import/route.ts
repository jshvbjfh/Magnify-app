import { NextResponse } from 'next/server'
import { compare } from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import type { OwnerSyncSnapshot } from '@/lib/ownerSync'

async function resolveRestaurantForUser(user: { id: string; role: string; restaurantId?: string | null }) {
  if (user.role === 'admin') {
    return prisma.restaurant.findUnique({ where: { ownerId: user.id }, select: { id: true, name: true } })
  }

  if (user.role === 'owner' && user.restaurantId) {
    return prisma.restaurant.findUnique({ where: { id: user.restaurantId }, select: { id: true, name: true } })
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

    const restaurant = await resolveRestaurantForUser({ id: user.id, role: user.role, restaurantId: (user as any).restaurantId ?? null })
    if (!restaurant) {
      return NextResponse.json({ error: 'No restaurant is linked to these sync credentials' }, { status: 403 })
    }

    if (snapshot.restaurantName && restaurant.name && snapshot.restaurantName !== restaurant.name) {
      // Allow renamed branches later, but keep the destination branch explicit.
    }

    const type = `owner_sync_snapshot:${restaurant.id}`
    const existing = await prisma.financialStatement.findFirst({
      where: { type },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    })

    const periodStart = snapshot.sales.length > 0
      ? new Date(snapshot.sales[snapshot.sales.length - 1].date)
      : new Date(snapshot.generatedAt)
    const periodEnd = new Date(snapshot.generatedAt)
    const payload = JSON.stringify(snapshot)

    if (existing) {
      await prisma.financialStatement.update({
        where: { id: existing.id },
        data: { periodStart, periodEnd, data: payload },
      })
    } else {
      await prisma.financialStatement.create({
        data: { type, periodStart, periodEnd, data: payload },
      })
    }

    return NextResponse.json({ ok: true, syncedAt: snapshot.generatedAt, restaurantId: restaurant.id })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to import branch snapshot' },
      { status: 500 }
    )
  }
}
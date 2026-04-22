import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const plans = await prisma.pricingPlan.findMany({ orderBy: { duration: 'asc' } })
  return NextResponse.json(plans)
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { name, duration, price, currency } = body

  if (!name || !duration || price == null) {
    return NextResponse.json({ error: 'name, duration and price are required' }, { status: 400 })
  }

  const plan = await prisma.pricingPlan.create({
    data: {
      name: String(name),
      duration: Number(duration),
      price: Number(price),
      currency: currency || 'RWF',
      seedKey: null,
      systemManaged: false,
    },
  })

  await enqueueSyncChange(prisma, {
    entityType: 'pricingPlan',
    entityId: plan.id,
    operation: 'upsert',
    payload: plan,
  })

  return NextResponse.json(plan, { status: 201 })
}

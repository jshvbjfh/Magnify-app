import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const data: Record<string, unknown> = {}
  if (body.name != null) data.name = String(body.name)
  if (body.duration != null) data.duration = Number(body.duration)
  if (body.price != null) data.price = Number(body.price)
  if (body.currency != null) data.currency = String(body.currency)
  if (body.isActive != null) data.isActive = Boolean(body.isActive)

  const plan = await prisma.pricingPlan.update({ where: { id: params.id }, data })

  await enqueueSyncChange(prisma, {
    entityType: 'pricingPlan',
    entityId: plan.id,
    operation: 'upsert',
    payload: plan,
  })

  return NextResponse.json(plan)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const plan = await prisma.pricingPlan.findUnique({ where: { id: params.id } })
  await prisma.pricingPlan.delete({ where: { id: params.id } })

  await enqueueSyncChange(prisma, {
    entityType: 'pricingPlan',
    entityId: params.id,
    operation: 'delete',
    payload: plan ? { id: plan.id } : { id: params.id },
  })

  return NextResponse.json({ ok: true })
}

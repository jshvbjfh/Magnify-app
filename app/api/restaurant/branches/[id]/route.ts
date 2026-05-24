import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export const dynamic = 'force-dynamic'

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const role = String((session.user as any).role ?? '')
  if (role !== 'admin') return NextResponse.json({ error: 'Only the restaurant admin can edit branches.' }, { status: 403 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId) return NextResponse.json({ error: 'No restaurant found' }, { status: 400 })

  const branchId = params.id
  const body = await req.json().catch(() => ({}))
  const name = String(body?.name ?? '').trim()
  const code = typeof body?.code === 'string' ? body.code.trim() : null

  if (!name) return NextResponse.json({ error: 'Branch name is required' }, { status: 400 })

  const existing = await prisma.branch.findFirst({
    where: { id: branchId, restaurantId: context.restaurantId, isActive: true },
  })
  if (!existing) return NextResponse.json({ error: 'Branch not found' }, { status: 404 })

  const updated = await prisma.$transaction(async (tx) => {
    const branch = await tx.branch.update({
      where: { id: branchId },
      data: { name, ...(code ? { code } : {}) },
      select: { id: true, name: true, code: true, isMain: true, isActive: true },
    })
    await enqueueSyncChange(tx, {
      restaurantId: context.restaurantId!,
      entityType: 'branch',
      entityId: branch.id,
      operation: 'upsert',
      payload: branch,
    })
    return branch
  })

  const branches = await prisma.branch.findMany({
    where: { restaurantId: context.restaurantId, isActive: true },
    orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, code: true, isMain: true, isActive: true },
  })

  return NextResponse.json({ ok: true, branch: updated, branches })
}

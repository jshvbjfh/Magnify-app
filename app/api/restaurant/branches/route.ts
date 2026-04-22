import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { createRestaurantBranch, ensureMainBranchForRestaurant, getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

const branchTabSelect = {
  id: true,
  name: true,
  code: true,
  isMain: true,
  isActive: true,
  sortOrder: true,
} as const

async function listActiveBranches(restaurantId: string) {
  return prisma.restaurantBranch.findMany({
    where: { restaurantId, isActive: true },
    orderBy: [
      { isMain: 'desc' },
      { sortOrder: 'asc' },
      { name: 'asc' },
    ],
    select: branchTabSelect,
  })
}

async function getAuthorizedBranchContext() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const context = await getRestaurantContextForUser(session.user.id)
  const restaurantId = context?.restaurantId ?? null
  if (!restaurantId) {
    return {
      session,
      context,
      restaurantId: null,
      branches: [] as Array<{ id: string; name: string; code: string; isMain: boolean; isActive: boolean; sortOrder: number }>,
      activeBranchId: null as string | null,
    }
  }

  await ensureMainBranchForRestaurant(restaurantId)

  const branches = await listActiveBranches(restaurantId)

  const activeBranchId = branches.some((branch) => branch.id === context?.branchId)
    ? context?.branchId ?? null
    : branches[0]?.id ?? null

  if (activeBranchId && activeBranchId !== context?.branchId) {
    await prisma.user.update({
      where: { id: session.user.id },
      data: { branchId: activeBranchId },
    })
  }

  return {
    session,
    context,
    restaurantId,
    branches,
    activeBranchId,
  }
}

export async function GET() {
  const result = await getAuthorizedBranchContext()
  if ('error' in result) return result.error

  return NextResponse.json({
    activeBranchId: result.activeBranchId,
    branches: result.branches,
  })
}

export async function PATCH(req: Request) {
  const result = await getAuthorizedBranchContext()
  if ('error' in result) return result.error

  if (!result.session?.user?.id || !result.restaurantId) {
    return NextResponse.json({ error: 'No restaurant found' }, { status: 400 })
  }

  const role = String((result.session.user as { role?: string }).role ?? '')
  if (role !== 'admin' && role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const branchId = String(body?.branchId ?? '').trim()
  if (!branchId) {
    return NextResponse.json({ error: 'branchId is required' }, { status: 400 })
  }

  const branch = await prisma.restaurantBranch.findFirst({
    where: {
      id: branchId,
      restaurantId: result.restaurantId,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      code: true,
      isMain: true,
    },
  })

  if (!branch) {
    return NextResponse.json({ error: 'Branch not found' }, { status: 404 })
  }

  await prisma.user.update({
    where: { id: result.session.user.id },
    data: { branchId: branch.id },
  })

  return NextResponse.json({
    ok: true,
    activeBranchId: branch.id,
    branch,
  })
}

export async function POST(req: Request) {
  const result = await getAuthorizedBranchContext()
  if ('error' in result) return result.error

  if (!result.session?.user?.id || !result.restaurantId) {
    return NextResponse.json({ error: 'No restaurant found' }, { status: 400 })
  }

  const role = String((result.session.user as { role?: string }).role ?? '')
  if (role !== 'admin') {
    return NextResponse.json({ error: 'Only the restaurant admin can create branches.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const name = String(body?.name ?? '').trim()
  const code = typeof body?.code === 'string' ? body.code : null

  if (!name) {
    return NextResponse.json({ error: 'Branch name is required' }, { status: 400 })
  }

  try {
    const branch = await prisma.$transaction(async (tx) => {
      const createdBranch = await createRestaurantBranch({
        restaurantId: result.restaurantId,
        name,
        code,
      }, tx)

      await enqueueSyncChange(tx, {
        restaurantId: result.restaurantId,
        entityType: 'restaurantBranch',
        entityId: createdBranch.id,
        operation: 'upsert',
        payload: createdBranch,
      })

      return createdBranch
    })

    const branches = await listActiveBranches(result.restaurantId)

    return NextResponse.json({
      ok: true,
      activeBranchId: result.activeBranchId,
      branch,
      branches,
    }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create branch'
    const status = message.includes('already exists') ? 409 : message.includes('required') ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import {
  ACTIVE_BRANCH_COOKIE_NAME,
  createBranch,
} from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'
import { cached } from '@/lib/apiCache'

const branchTabSelect = {
  id: true,
  name: true,
  code: true,
  type: true,
  isMain: true,
  isActive: true,
} as const

async function listActiveBranches(restaurantId: string) {
  return prisma.branch.findMany({
    where: { restaurantId, isActive: true },
    orderBy: [
      { isMain: 'desc' },
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

  const user = session.user as { id: string; restaurantId?: string | null; branchId?: string | null; role?: string }
  const restaurantId = typeof user.restaurantId === 'string' ? user.restaurantId : null

  if (!restaurantId) {
    return {
      session,
      restaurantId: null as null,
      branches: [] as Array<{ id: string; name: string; code: string; type: string; isMain: boolean; isActive: boolean }>,
      activeBranchId: null as string | null,
    }
  }

  // One DB query — list branches. Auth context comes from JWT (zero extra queries).
  const sessionBranchId = typeof user.branchId === 'string' ? user.branchId : null
  const branches = await listActiveBranches(restaurantId)

  const activeBranchId = branches.some(b => b.id === sessionBranchId)
    ? sessionBranchId
    : branches[0]?.id ?? null

  return {
    session,
    restaurantId,
    branches,
    activeBranchId,
  }
}

function withActiveBranchCookie(response: NextResponse, restaurantId: string | null, branchId: string | null) {
  if (!restaurantId || !branchId) {
    response.cookies.delete(ACTIVE_BRANCH_COOKIE_NAME)
    return response
  }

  response.cookies.set({
    name: ACTIVE_BRANCH_COOKIE_NAME,
    value: `${restaurantId}:${branchId}`,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  })

  return response
}

export async function GET() {
  const result = await getAuthorizedBranchContext()
  if ('error' in result) return result.error

  return withActiveBranchCookie(cached({
    activeBranchId: result.activeBranchId,
    branches: result.branches,
  }, 15, 60), result.restaurantId, result.activeBranchId)
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

  const branch = await prisma.branch.findFirst({
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

  return withActiveBranchCookie(NextResponse.json({
    ok: true,
    activeBranchId: branch.id,
    branch,
  }), result.restaurantId, branch.id)
}

export async function POST(req: Request) {
  const result = await getAuthorizedBranchContext()
  if ('error' in result) return result.error

  if (!result.session?.user?.id || !result.restaurantId) {
    return NextResponse.json({ error: 'No restaurant found' }, { status: 400 })
  }

  const restaurantId = result.restaurantId

  const role = String((result.session.user as { role?: string }).role ?? '')
  if (role !== 'admin') {
    return NextResponse.json({ error: 'Only the restaurant admin can create branches.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const name = String(body?.name ?? '').trim()
  const type = body?.type === 'bar' ? 'bar' : 'kitchen'

  if (!name) {
    return NextResponse.json({ error: 'Branch name is required' }, { status: 400 })
  }

  try {
    const branch = await prisma.$transaction(async (tx) => {
      const createdBranch = await createBranch({
        restaurantId,
        name,
        type,
      }, tx)

      await enqueueSyncChange(tx, {
        restaurantId,
        entityType: 'branch',
        entityId: createdBranch.id,
        operation: 'upsert',
        payload: createdBranch,
      })

      return createdBranch
    })

    const branches = await listActiveBranches(restaurantId)

    return withActiveBranchCookie(NextResponse.json({
      ok: true,
      activeBranchId: result.activeBranchId,
      branch,
      branches,
    }, { status: 201 }), restaurantId, result.activeBranchId)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create branch'
    const status = message.includes('already exists') ? 409 : message.includes('required') ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { jwtVerify } from 'jose'

export const dynamic = 'force-dynamic'

const SECRET = new TextEncoder().encode(
  process.env.NEXTAUTH_SECRET ?? 'fallback-secret-change-me'
)

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      ...(init?.headers ?? {}),
    },
  })
}

async function verifyToken(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) throw new Error('Unauthorized')
  const { payload } = await jwtVerify(token, SECRET)
  return payload as { sub: string; restaurantId: string; branchId: string; role: string }
}

const NEXT_STATUS: Record<string, string> = {
  new: 'in_kitchen',
  in_kitchen: 'ready',
  ready: 'served',
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await verifyToken(req)
    const { id } = await params
    const body = await req.json() as { kitchenStatus?: string }
    const requestedStatus = typeof body.kitchenStatus === 'string' ? body.kitchenStatus : null

    const item = await prisma.orderItem.findUnique({
      where: { id },
      select: { id: true, kitchenStatus: true },
    })

    if (!item) return jsonNoStore({ error: 'Item not found' }, { status: 404 })

    const nextStatus = requestedStatus ?? NEXT_STATUS[item.kitchenStatus] ?? item.kitchenStatus

    if (requestedStatus && NEXT_STATUS[item.kitchenStatus] !== requestedStatus) {
      return jsonNoStore({ error: 'Invalid status transition' }, { status: 400 })
    }

    const updated = await prisma.orderItem.update({
      where: { id },
      data: {
        kitchenStatus: nextStatus,
        ...(nextStatus === 'ready' ? { readyAt: new Date() } : {}),
      },
      select: { id: true, kitchenStatus: true },
    })

    return jsonNoStore(updated)
  } catch (err) {
    console.error('[kitchen/item]', err)
    return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
  }
}

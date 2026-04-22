import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { prisma } from '@/lib/prisma'
import { authOptions } from '@/lib/auth'

async function requireAdminSession() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = session.user as any
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  return null
}

function checkKey(req: Request) {
  const url = new URL(req.url)
  const key = url.searchParams.get('key') || req.headers.get('x-dev-key')
  if (key !== process.env.DEV_ADMIN_KEY) throw new Error('Unauthorized')
}

/** POST body: { restaurantId, action: 'grant'|'revoke'|'suspend'|'unsuspend', months?: number } */
export async function POST(req: Request) {
  try {
    const authError = await requireAdminSession()
    if (authError) return authError

    checkKey(req)
    const { restaurantId, action, months = 1 } = await req.json()
    if (!restaurantId || !action) {
      return NextResponse.json({ error: 'restaurantId and action required' }, { status: 400 })
    }

    let data: any = {}

    if (action === 'grant') {
      const expiry = new Date()
      expiry.setMonth(expiry.getMonth() + months)
      data = { licenseExpiry: expiry, licenseActive: true }
    } else if (action === 'revoke') {
      data = { licenseExpiry: null }
    } else if (action === 'suspend') {
      data = { licenseActive: false }
    } else if (action === 'unsuspend') {
      data = { licenseActive: true }
    } else if (action === 'reset-trial') {
      data = { trialStartAt: new Date(), licenseExpiry: null, licenseActive: true }
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    const updated = await prisma.restaurant.update({
      where: { id: restaurantId },
      data,
    })

    return NextResponse.json({ ok: true, restaurant: updated })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.message === 'Unauthorized' ? 401 : 500 })
  }
}

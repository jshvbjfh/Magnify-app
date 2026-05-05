import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { getRestaurantBootstrapStatus, isRestaurantBootstrapRole } from '@/lib/restaurantBootstrap'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const role = (session.user as any)?.role
  if (!isRestaurantBootstrapRole(role)) {
    return NextResponse.json({
      ready: true,
      required: false,
      isLocalFirst: false,
      hasCloudBridge: false,
      hasLocalData: true,
      lastSuccessfulSyncAt: null,
      message: null,
    })
  }

  const status = await getRestaurantBootstrapStatus(session.user.id)
  return NextResponse.json(status)
}
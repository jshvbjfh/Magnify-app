import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { cached } from '@/lib/apiCache'

// GET outstanding A/R: PAID credit orders not yet collected
export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    const restaurantId = context?.restaurantId ?? null
    const branchId = context?.branchId ?? null
    if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant station found' }, { status: 400 })

    const orders = await prisma.restaurantOrder.findMany({
      where: {
        restaurantId,
        branchId,
        status: 'PAID',
        paymentMethod: 'Credit',
        arCollectedAt: null,
      },
      select: {
        id: true,
        orderNumber: true,
        tableName: true,
        totalAmount: true,
        paidAt: true,
        arCustomerName: true,
        arCollectedAt: true,
      },
      orderBy: { paidAt: 'asc' },
    })

    return cached(orders)
  } catch (error: any) {
    console.error('Failed to load A/R orders:', error)
    return NextResponse.json({ error: error?.message || 'Failed to load A/R orders' }, { status: 500 })
  }
}

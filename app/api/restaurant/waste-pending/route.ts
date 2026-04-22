import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { databaseUnavailableJson, isPrismaDatabaseUnavailableError, logDatabaseUnavailable } from '@/lib/apiDatabase'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ items: [] }, { status: 401 })

    const context = await getRestaurantContextForUser(session.user.id)
    if (!context?.restaurantId || !context.branchId) return NextResponse.json({ items: [] }, { status: 400 })

    const items = await prisma.restaurantOrderItem.findMany({
      where: {
        status: 'WASTED',
        wasteAcknowledged: false,
        order: {
          restaurantId: context.restaurantId,
          branchId: context.branchId,
        },
      },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            tableId: true,
            tableName: true,
            createdByName: true,
          },
        },
      },
      orderBy: { wastedAt: 'desc' },
    })

    return NextResponse.json({
      count: items.length,
      items: items.map((item) => ({
        id: item.id,
        orderId: item.orderId,
        orderNumber: item.order.orderNumber,
        tableId: item.order.tableId,
        tableName: item.order.tableName,
        dishName: item.dishName,
        dishPrice: item.dishPrice,
        qty: item.qty,
        wastedAt: item.wastedAt,
        wastedByName: item.wastedByName,
        approvedByName: item.cancellationApprovedByEmployeeName,
        wasteReason: item.wasteReason,
        waiterName: item.order.createdByName,
      })),
    })
  } catch (error) {
    if (isPrismaDatabaseUnavailableError(error)) {
      logDatabaseUnavailable('api/restaurant/waste-pending GET', error)
      return databaseUnavailableJson({
        body: { count: 0, items: [] },
        message: 'Waste review is temporarily unavailable while the database connection is down.',
      })
    }

    console.error('Error fetching waste-pending items:', error)
    return NextResponse.json({ count: 0, items: [] }, { status: 500 })
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = await getRestaurantContextForUser(session.user.id)
    if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

    const { itemId } = await req.json()
    if (!itemId || typeof itemId !== 'string') {
      return NextResponse.json({ error: 'Waste item id is required' }, { status: 400 })
    }

    const item = await prisma.restaurantOrderItem.findFirst({
      where: {
        id: itemId,
        status: 'WASTED',
        order: { restaurantId: context.restaurantId, branchId: context.branchId },
      },
      select: { id: true, wasteAcknowledged: true },
    })

    if (!item) {
      return NextResponse.json({ error: 'Waste item not found' }, { status: 404 })
    }

    if (item.wasteAcknowledged) {
      return NextResponse.json({ ok: true })
    }

    await prisma.restaurantOrderItem.update({
      where: { id: itemId },
      data: { wasteAcknowledged: true },
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isPrismaDatabaseUnavailableError(error)) {
      logDatabaseUnavailable('api/restaurant/waste-pending PATCH', error)
      return databaseUnavailableJson({
        message: 'Waste acknowledgement could not be saved because the database connection is down.',
      })
    }

    console.error('Error updating waste-pending item:', error)
    return NextResponse.json({ error: 'Failed to update waste item' }, { status: 500 })
  }
}
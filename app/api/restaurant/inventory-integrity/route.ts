import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { getRestaurantInventoryIntegrity } from '@/lib/inventoryIntegrity'
import { prisma } from '@/lib/prisma'

export async function GET() {
	const session = await getServerSession(authOptions)
	if (!session?.user?.id) {
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
	}

	const context = await getRestaurantContextForUser(session.user.id)
	if (!context?.restaurantId || !context.branchId) {
		return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
	}

	const billingUserId = context.billingUserId ?? session.user.id
	const integrity = await getRestaurantInventoryIntegrity(prisma, {
		billingUserId,
		restaurantId: context.restaurantId,
		branchId: context.branchId,
	})

	return NextResponse.json(integrity)
}
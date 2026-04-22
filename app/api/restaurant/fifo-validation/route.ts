import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { getRestaurantFifoValidation } from '@/lib/fifoValidation'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

export async function GET() {
	const session = await getServerSession(authOptions)
	if (!session?.user?.id) {
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
	}

	const role = (session.user as any).role
	if (role !== 'admin' && role !== 'owner') {
		return NextResponse.json({ error: 'Admin only' }, { status: 403 })
	}

	const context = await getRestaurantContextForUser(session.user.id)
	if (!context?.restaurantId || !context.branchId) {
		return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
	}

	const validation = await getRestaurantFifoValidation(prisma, {
		billingUserId: context.billingUserId,
		restaurantId: context.restaurantId,
		branchId: context.branchId,
	})

	return NextResponse.json(validation)
}
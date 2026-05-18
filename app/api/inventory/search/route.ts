export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

export async function GET(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const context = await getRestaurantContextForUser(session.user.id)
		if (!context?.restaurantId || !context.branchId) {
			return NextResponse.json({ items: [] })
		}

		const { searchParams } = new URL(req.url)
		const query = searchParams.get('q') || ''

		const items = await prisma.inventoryItem.findMany({
			where: {
				restaurantId: context.restaurantId,
				branchId: context.branchId,
				name: { contains: query },
			},
			select: {
				id: true,
				name: true,
				unit: true,
				unitCost: true,
				quantity: true,
				category: true,
			},
		})

		return NextResponse.json({ items })
	} catch (error: any) {
		console.error('Error searching inventory:', error)
		return NextResponse.json(
			{ error: 'Failed to search inventory items' },
			{ status: 500 }
		)
	}
}

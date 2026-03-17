export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// GET search inventory items by name (for AI to use)
export async function GET(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const { searchParams } = new URL(req.url)
		const query = searchParams.get('q') || ''

		const items = await prisma.inventoryItem.findMany({
			where: {
				userId: session.user.id,
				name: {
					contains: query
				}
			},
			select: {
				id: true,
				name: true,
				unit: true,
				unitPrice: true,
				quantity: true,
				category: true
			}
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

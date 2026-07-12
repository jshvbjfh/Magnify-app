import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'

export async function PATCH(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> }
) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
		if (!context?.restaurantId || !context.branchId) {
			return NextResponse.json({ error: 'No restaurant station found' }, { status: 400 })
		}

		const { id } = await params
		const body = await request.json()
		const { quantity, name, unit, unitCost, category, reorderLevel } = body

		const currentItem = await prisma.inventoryItem.findFirst({
			where: { id, restaurantId: context.restaurantId, branchId: context.branchId },
		})

		if (!currentItem) {
			return NextResponse.json({ error: 'Item not found' }, { status: 404 })
		}

		const updateData: Record<string, unknown> = {}

		if (quantity !== undefined) {
			updateData.quantity = currentItem.quantity + parseFloat(quantity)
		}
		if (name !== undefined) updateData.name = name
		if (unit !== undefined) updateData.unit = unit
		if (unitCost !== undefined) updateData.unitCost = parseFloat(unitCost)
		if (category !== undefined) updateData.category = category
		if (reorderLevel !== undefined) updateData.reorderLevel = parseFloat(reorderLevel)

		const updatedItem = await prisma.inventoryItem.update({
			where: { id },
			data: updateData,
		})

		return NextResponse.json({ success: true, item: updatedItem })
	} catch (error: any) {
		console.error('Inventory update error:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to update inventory' },
			{ status: 500 }
		)
	}
}

export async function DELETE(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> }
) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
		if (!context?.restaurantId || !context.branchId) {
			return NextResponse.json({ error: 'No restaurant station found' }, { status: 400 })
		}

		const { id } = await params

		const item = await prisma.inventoryItem.findFirst({
			where: { id, restaurantId: context.restaurantId, branchId: context.branchId },
		})

		if (!item) {
			return NextResponse.json({ error: 'Item not found' }, { status: 404 })
		}

		await prisma.inventoryItem.delete({ where: { id } })

		return NextResponse.json({ success: true })
	} catch (error: any) {
		console.error('Inventory delete error:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to delete inventory item' },
			{ status: 500 }
		)
	}
}

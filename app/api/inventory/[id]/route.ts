import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// PATCH: Update inventory item (quantity or other fields)
export async function PATCH(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> }
) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const { id } = await params
		const body = await request.json()
		const { quantity, itemName, unit, pricePerUnit, category, reorderLevel } = body

		// Get current item
		const currentItem = await prisma.inventoryItem.findUnique({
			where: { id, userId: session.user.id }
		})

		if (!currentItem) {
			return NextResponse.json({ error: 'Item not found' }, { status: 404 })
		}

		// Prepare update data
		const updateData: any = {}

		// Handle quantity update (can be incremental)
		if (quantity !== undefined) {
			const qtyChange = parseFloat(quantity)
			updateData.quantity = currentItem.quantity + qtyChange
		}

		// Handle other field updates
		if (itemName !== undefined) updateData.itemName = itemName
		if (unit !== undefined) updateData.unit = unit
		if (pricePerUnit !== undefined) updateData.pricePerUnit = parseFloat(pricePerUnit)
		if (category !== undefined) updateData.category = category
		if (reorderLevel !== undefined) updateData.reorderLevel = parseFloat(reorderLevel)

		// Update the item
		const updatedItem = await prisma.inventoryItem.update({
			where: { id },
			data: updateData
		})

		return NextResponse.json({
			success: true,
			item: updatedItem
		})
	} catch (error: any) {
		console.error('Inventory update error:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to update inventory' },
			{ status: 500 }
		)
	}
}

// DELETE: Remove inventory item
export async function DELETE(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> }
) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const { id } = await params
		// Verify ownership
		const item = await prisma.inventoryItem.findUnique({
			where: { id, userId: session.user.id }
		})

		if (!item) {
			return NextResponse.json({ error: 'Item not found' }, { status: 404 })
		}

		// Delete the item
		await prisma.inventoryItem.delete({
			where: { id }
		})

		return NextResponse.json({ success: true })
	} catch (error: any) {
		console.error('Inventory delete error:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to delete inventory item' },
			{ status: 500 }
		)
	}
}

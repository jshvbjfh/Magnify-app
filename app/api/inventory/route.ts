import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import fs from 'fs'
import path from 'path'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { generateInventoryBatchId } from '@/lib/inventoryBatch'
import { enqueueSyncChange } from '@/lib/syncOutbox'

const isProduction = process.env.NODE_ENV === 'production'

function logServerError(message: string, error: any) {
	if (isProduction) {
		console.error(message)
		return
	}

	console.error(message, error)
}

function getInventoryErrorLogPath() {
	if (process.env.INVENTORY_ERROR_LOG_PATH) return process.env.INVENTORY_ERROR_LOG_PATH

	if (process.env.APPDATA) {
		return path.join(process.env.APPDATA, 'Magnify', 'inventory-errors.log')
	}

	return path.join(process.cwd(), 'inventory-errors.log')
}

function logInventoryError(action: 'GET' | 'POST' | 'PUT' | 'DELETE', error: any, userId?: string) {
	try {
		const logPath = getInventoryErrorLogPath()
		const logDir = path.dirname(logPath)
		fs.mkdirSync(logDir, { recursive: true })

		const entry = [
			`[${new Date().toISOString()}] inventory ${action} failed`,
			(!isProduction ? `userId: ${userId || 'unknown'}` : null),
			`code: ${error?.code || 'N/A'}`,
			`message: ${isProduction ? 'Internal inventory error' : error?.message || String(error)}`,
			(!isProduction && error?.stack ? `stack: ${error.stack}` : null),
			''
		].filter(Boolean).join('\n')

		fs.appendFileSync(logPath, entry + '\n', 'utf8')
	} catch (logErr) {
		logServerError('Failed to write inventory error log:', logErr)
	}
}

// GET all inventory items for the user
export async function GET(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const context = await getRestaurantContextForUser(session.user.id)
		const billingUserId = context?.billingUserId ?? session.user.id
		const restaurantId = context?.restaurantId ?? null
		const branchId = context?.branchId ?? null

		const items = await prisma.inventoryItem.findMany({
			where: {
				userId: billingUserId,
				...(restaurantId ? { restaurantId } : {}),
				...(branchId ? { branchId } : {}),
			},
			orderBy: { name: 'asc' }
		})

		return NextResponse.json({ items })
	} catch (error: any) {
		logServerError('Error fetching inventory:', error)
		logInventoryError('GET', error)
		return NextResponse.json(
			{ error: 'Failed to fetch inventory items' },
			{ status: 500 }
		)
	}
}

// POST create a new inventory item
export async function POST(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const body = await req.json()
		const context = await getRestaurantContextForUser(session.user.id)
		const billingUserId = context?.billingUserId ?? session.user.id
		const restaurantId = context?.restaurantId ?? null
		const branchId = context?.branchId ?? null
		const { name, description, unit, unitCost, unitPrice, quantity, category, reorderLevel, inventoryType, skipOpeningPurchase } = body

		// Validate required fields with specific messages
		const missingFields = []
		if (!name) missingFields.push('name (item name)')
		if (!unit) missingFields.push('unit (e.g., kg, liter, bunch, piece)')
		
		if (missingFields.length > 0) {
			return NextResponse.json(
				{ error: `Missing required fields: ${missingFields.join(', ')}` },
				{ status: 400 }
			)
		}

		const parsedUnitCost = unitCost !== undefined && unitCost !== null && unitCost !== '' ? parseFloat(String(unitCost)) : null
		const parsedQuantity = quantity !== undefined && quantity !== null && quantity !== '' ? parseFloat(String(quantity)) : 0

		if (skipOpeningPurchase && parsedQuantity > 0) {
			return NextResponse.json(
				{ error: 'Strict FIFO requires an opening purchase batch when you create stock. Remove opening quantity or record it as a batch.' },
				{ status: 409 }
			)
		}

		if (parsedQuantity > 0 && parsedUnitCost === null) {
			return NextResponse.json(
				{ error: 'Strict FIFO requires a unit cost when you create opening stock so the opening batch is fully costed.' },
				{ status: 400 }
			)
		}

		const item = await prisma.$transaction(async (tx) => {
			const openingPurchaseDate = new Date()
			const openingBatchId = !skipOpeningPurchase && parsedQuantity > 0 && parsedUnitCost !== null && parsedUnitCost >= 0
				? generateInventoryBatchId(openingPurchaseDate)
				: null
			const createdItem = await tx.inventoryItem.create({
				data: {
					userId: billingUserId,
					restaurantId,
					branchId,
					name,
					description,
					unit,
					unitCost: parsedUnitCost,
					unitPrice: unitPrice !== undefined && unitPrice !== null && unitPrice !== '' ? parseFloat(String(unitPrice)) : null,
					quantity: parsedQuantity,
					category: category || null,
					reorderLevel: reorderLevel !== undefined && reorderLevel !== null && reorderLevel !== '' ? parseFloat(String(reorderLevel)) : 0,
					inventoryType: inventoryType || 'resale',
					...(parsedQuantity > 0 ? { lastRestockedAt: openingPurchaseDate } : {}),
				} as any
			})

			if (!skipOpeningPurchase && parsedQuantity > 0 && parsedUnitCost !== null && parsedUnitCost >= 0) {
				await tx.inventoryPurchase.create({
					data: {
						userId: billingUserId,
						restaurantId,
						branchId,
						batchId: openingBatchId,
						ingredientId: createdItem.id,
						supplier: 'Opening Stock',
						quantityPurchased: parsedQuantity,
						remainingQuantity: parsedQuantity,
						unitCost: parsedUnitCost,
						totalCost: parsedQuantity * parsedUnitCost,
						purchasedAt: openingPurchaseDate,
					}
				})
			}

			if (parsedQuantity > 0) {
				await tx.inventoryAdjustmentLog.create({
					data: {
						userId: billingUserId,
						restaurantId,
						branchId,
						ingredientId: createdItem.id,
						adjustmentType: 'opening_balance',
						quantityDelta: parsedQuantity,
						itemQuantityBefore: 0,
						itemQuantityAfter: parsedQuantity,
						batchId: openingBatchId,
						reason: 'Opening stock seeded for inventory item.',
					},
				})
			}

			return createdItem
		})

		await enqueueSyncChange(prisma, {
			restaurantId,
			branchId,
			entityType: 'inventoryItem',
			entityId: item.id,
			operation: 'upsert',
			payload: item,
		})

		return NextResponse.json({ item }, { status: 201 })
	} catch (error: any) {
		logServerError('Error creating inventory item:', error)
		logInventoryError('POST', error)
		
		if (error.code === 'P2002') {
			return NextResponse.json(
				{ error: 'An item with this name already exists' },
				{ status: 409 }
			)
		}

		if (error.code === 'P2022') {
			return NextResponse.json(
				{
					error: 'Database schema is out of date for inventory. Please update the app so migrations can run.',
					code: error.code,
					details: error.message || null
				},
				{ status: 500 }
			)
		}

		return NextResponse.json(
			{
				error: error?.message || 'Failed to create inventory item',
				code: error?.code || null
			},
			{ status: 500 }
		)
	}
}

// PUT update an inventory item
export async function PUT(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const body = await req.json()
		const context = await getRestaurantContextForUser(session.user.id)
		const billingUserId = context?.billingUserId ?? session.user.id
		const restaurantId = context?.restaurantId ?? null
		const branchId = context?.branchId ?? null
		const { id, name, description, unit, unitCost, unitPrice, quantity, category, reorderLevel, inventoryType } = body

		if (!id) {
			return NextResponse.json(
				{ error: 'Item ID is required' },
				{ status: 400 }
			)
		}

		const existingItem = await prisma.inventoryItem.findFirst({
			where: {
				id,
				userId: billingUserId,
				...(restaurantId ? { restaurantId } : {}),
				...(branchId ? { branchId } : {}),
			},
		})

		if (!existingItem) {
			return NextResponse.json(
				{ error: 'Inventory item not found' },
				{ status: 404 }
			)
		}

		const parsedQuantity = quantity !== undefined && quantity !== null && quantity !== '' ? parseFloat(String(quantity)) : existingItem.quantity
		const parsedUnitCost = unitCost !== undefined && unitCost !== null && unitCost !== ''
			? parseFloat(String(unitCost))
			: existingItem.unitCost
		const quantityIncrease = parsedQuantity - existingItem.quantity

		if (quantity !== undefined && Math.abs(quantityIncrease) > Number.EPSILON) {
			return NextResponse.json(
				{ error: 'This app uses strict FIFO. Direct stock quantity edits are blocked. Use purchase batches or the FIFO adjustment flow.' },
				{ status: 409 }
			)
		}

		const item = await prisma.$transaction(async (tx) => {
			const updatedItem = await tx.inventoryItem.update({
				where: { id },
				data: {
					...(name && { name }),
					...(description !== undefined && { description }),
					...(unit && { unit }),
					...(unitCost !== undefined && { unitCost: unitCost !== null && unitCost !== '' ? parseFloat(String(unitCost)) : null }),
					...(unitPrice !== undefined && { unitPrice: unitPrice !== null && unitPrice !== '' ? parseFloat(String(unitPrice)) : null }),
					...(quantity !== undefined && { quantity: parsedQuantity }),
					...(category !== undefined && { category }),
					...(reorderLevel !== undefined && { reorderLevel: reorderLevel !== null && reorderLevel !== '' ? parseFloat(String(reorderLevel)) : 0 }),
					...(inventoryType !== undefined && { inventoryType })
				} as any
			})

			return updatedItem
		})

		await enqueueSyncChange(prisma, {
			restaurantId,
			branchId,
			entityType: 'inventoryItem',
			entityId: item.id,
			operation: 'upsert',
			payload: item,
		})

		return NextResponse.json({ item })
	} catch (error: any) {
		logServerError('Error updating inventory item:', error)
		logInventoryError('PUT', error)

		if (error.code === 'P2022') {
			return NextResponse.json(
				{
					error: 'Database schema is out of date for inventory. Please update the app so migrations can run.',
					code: error.code,
					details: error.message || null
				},
				{ status: 500 }
			)
		}

		return NextResponse.json(
			{
				error: error?.message || 'Failed to update inventory item',
				code: error?.code || null
			},
			{ status: 500 }
		)
	}
}

// DELETE an inventory item
export async function DELETE(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const { searchParams } = new URL(req.url)
		const context = await getRestaurantContextForUser(session.user.id)
		const billingUserId = context?.billingUserId ?? session.user.id
		const restaurantId = context?.restaurantId ?? null
		const branchId = context?.branchId ?? null
		const id = searchParams.get('id')

		if (!id) {
			return NextResponse.json(
				{ error: 'Item ID is required' },
				{ status: 400 }
			)
		}

		const existingItem = await prisma.inventoryItem.findFirst({
			where: {
				id,
				userId: billingUserId,
				...(restaurantId ? { restaurantId } : {}),
				...(branchId ? { branchId } : {}),
			},
		})

		if (!existingItem) {
			return NextResponse.json(
				{ error: 'Inventory item not found' },
				{ status: 404 }
			)
		}

		await prisma.inventoryItem.delete({
			where: { id }
		})

		await enqueueSyncChange(prisma, {
			restaurantId,
			branchId,
			entityType: 'inventoryItem',
			entityId: id,
			operation: 'delete',
			payload: { id },
		})

		return NextResponse.json({ success: true })
	} catch (error: any) {
		logServerError('Error deleting inventory item:', error)
		logInventoryError('DELETE', error)
		return NextResponse.json(
			{
				error: error?.message || 'Failed to delete inventory item',
				code: error?.code || null
			},
			{ status: 500 }
		)
	}
}

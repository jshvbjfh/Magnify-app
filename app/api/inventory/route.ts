import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import fs from 'fs'
import path from 'path'

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
			`userId: ${userId || 'unknown'}`,
			`code: ${error?.code || 'N/A'}`,
			`message: ${error?.message || String(error)}`,
			(error?.stack ? `stack: ${error.stack}` : null),
			''
		].filter(Boolean).join('\n')

		fs.appendFileSync(logPath, entry + '\n', 'utf8')
	} catch (logErr) {
		console.error('Failed to write inventory error log:', logErr)
	}
}

// GET all inventory items for the user
export async function GET(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const items = await prisma.inventoryItem.findMany({
			where: { userId: session.user.id },
			orderBy: { name: 'asc' }
		})

		return NextResponse.json({ items })
	} catch (error: any) {
		console.error('Error fetching inventory:', error)
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
		const { name, description, unit, unitCost, unitPrice, quantity, category } = body

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

		const item = await prisma.inventoryItem.create({
			data: {
				userId: session.user.id,
				name,
				description,
				unit,
				unitCost: unitCost ? parseFloat(unitCost) : null,
				unitPrice: unitPrice ? parseFloat(unitPrice) : null,
				quantity: quantity ? parseFloat(quantity) : 0,
				category: category || null
			} as any
		})

		return NextResponse.json({ item }, { status: 201 })
	} catch (error: any) {
		console.error('Error creating inventory item:', error)
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
		const { id, name, description, unit, unitCost, unitPrice, quantity, category } = body

		if (!id) {
			return NextResponse.json(
				{ error: 'Item ID is required' },
				{ status: 400 }
			)
		}

		const item = await prisma.inventoryItem.update({
			where: {
				id,
				userId: session.user.id // Ensure user owns this item
			},
			data: {
				...(name && { name }),
				...(description !== undefined && { description }),
				...(unit && { unit }),
				...(unitCost !== undefined && { unitCost: unitCost ? parseFloat(unitCost) : null }),
				...(unitPrice !== undefined && { unitPrice: unitPrice ? parseFloat(unitPrice) : null }),
				...(quantity !== undefined && { quantity: parseFloat(quantity) }),
				...(category !== undefined && { category })
			} as any
		})

		return NextResponse.json({ item })
	} catch (error: any) {
		console.error('Error updating inventory item:', error)
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
		const id = searchParams.get('id')

		if (!id) {
			return NextResponse.json(
				{ error: 'Item ID is required' },
				{ status: 400 }
			)
		}

		await prisma.inventoryItem.delete({
			where: {
				id,
				userId: session.user.id // Ensure user owns this item
			}
		})

		return NextResponse.json({ success: true })
	} catch (error: any) {
		console.error('Error deleting inventory item:', error)
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

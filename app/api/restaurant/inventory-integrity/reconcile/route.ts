import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { getRestaurantFifoAvailability } from '@/lib/fifoRollout'
import { applyRestaurantInventoryReconciliation, previewRestaurantInventoryReconciliation } from '@/lib/inventoryReconciliation'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

function getEffectiveAt(value: unknown) {
	if (!value) return undefined
	const parsed = new Date(String(value))
	return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function getIngredientIds(value: unknown) {
	if (!Array.isArray(value)) return undefined
	return value.map((entry) => String(entry || '').trim()).filter(Boolean)
}

async function requireRestaurantAdminContext() {
	const session = await getServerSession(authOptions)
	if (!session?.user?.id) {
		return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
	}

	const role = (session.user as any).role
	if (role !== 'admin' && role !== 'owner') {
		return { error: NextResponse.json({ error: 'Admin only' }, { status: 403 }) }
	}

	const context = await getRestaurantContextForUser(session.user.id)
	if (!context?.restaurantId || !context.branchId) {
		return { error: NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 }) }
	}

	return {
		session,
		context,
		error: null,
	}
}

export async function GET(req: Request) {
	const result = await requireRestaurantAdminContext()
	if (result.error) return result.error

	const { searchParams } = new URL(req.url)
	const effectiveAt = getEffectiveAt(searchParams.get('effectiveAt'))
	const ingredientIds = searchParams.getAll('ingredientId')

	const preview = await previewRestaurantInventoryReconciliation(prisma, {
		billingUserId: result.context.billingUserId,
		restaurantId: result.context.restaurantId,
		branchId: result.context.branchId,
		effectiveAt,
		ingredientIds: ingredientIds.length > 0 ? ingredientIds : undefined,
	})

	return NextResponse.json(preview)
}

export async function POST(req: Request) {
	const result = await requireRestaurantAdminContext()
	if (result.error) return result.error

	const body = await req.json().catch(() => null)
	const mode = body?.mode === 'apply' ? 'apply' : 'preview'
	const effectiveAt = getEffectiveAt(body?.effectiveAt)
	const ingredientIds = getIngredientIds(body?.ingredientIds)

	if (mode !== 'apply') {
		const preview = await previewRestaurantInventoryReconciliation(prisma, {
			billingUserId: result.context.billingUserId,
			restaurantId: result.context.restaurantId,
			branchId: result.context.branchId,
			effectiveAt,
			ingredientIds,
		})

		return NextResponse.json(preview)
	}

	if (String(body?.confirm || '').trim().toUpperCase() !== 'RECONCILE') {
		return NextResponse.json({ error: 'Confirmation text RECONCILE is required before applying reconciliation.' }, { status: 400 })
	}

	if (!effectiveAt) {
		return NextResponse.json({ error: 'A valid effectiveAt timestamp is required when applying reconciliation.' }, { status: 400 })
	}

	if (!getRestaurantFifoAvailability(result.context.restaurant)) {
		return NextResponse.json({ error: 'FIFO cutover apply is only available for pilot-enabled branches. Add this branch to FIFO_PILOT_RESTAURANTS first.' }, { status: 409 })
	}

	const applied = await prisma.$transaction((tx) => applyRestaurantInventoryReconciliation(tx, {
		billingUserId: result.context.billingUserId,
		restaurantId: result.context.restaurantId,
		branchId: result.context.branchId,
		effectiveAt,
		ingredientIds,
	}), { timeout: 60000 })

	return NextResponse.json(applied)
}
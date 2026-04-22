import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

export async function GET() {
	const session = await getServerSession(authOptions)
	if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

	const role = (session.user as any).role
	if (role !== 'admin' && role !== 'owner') {
		return NextResponse.json({ error: 'Admin only' }, { status: 403 })
	}

	const context = await getRestaurantContextForUser(session.user.id)
	if (!context?.restaurantId || !context.branchId) {
		return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
	}

	const [
		totalOrders,
		paidOrders,
		pendingOrders,
		totalTransactionCount,
		restaurantScopedTransactionCount,
		lastOrder,
		lastPaidOrder,
		lastTransaction,
	] = await Promise.all([
		prisma.restaurantOrder.count({ where: { restaurantId: context.restaurantId, branchId: context.branchId } }),
		prisma.restaurantOrder.count({ where: { restaurantId: context.restaurantId, branchId: context.branchId, status: 'PAID' } }),
		prisma.restaurantOrder.count({ where: { restaurantId: context.restaurantId, branchId: context.branchId, status: 'PENDING' } }),
		prisma.transaction.count({ where: { userId: context.billingUserId } }),
		prisma.transaction.count({ where: { userId: context.billingUserId, restaurantId: context.restaurantId, branchId: context.branchId } }),
		prisma.restaurantOrder.findFirst({ where: { restaurantId: context.restaurantId, branchId: context.branchId }, orderBy: { createdAt: 'desc' }, select: { id: true, orderNumber: true, createdAt: true, status: true } }),
		prisma.restaurantOrder.findFirst({ where: { restaurantId: context.restaurantId, branchId: context.branchId, status: 'PAID' }, orderBy: { paidAt: 'desc' }, select: { id: true, orderNumber: true, paidAt: true, totalAmount: true, paymentMethod: true } }),
		prisma.transaction.findFirst({ where: { userId: context.billingUserId }, orderBy: { createdAt: 'desc' }, select: { id: true, description: true, amount: true, createdAt: true, paymentMethod: true, restaurantId: true } }),
	])

	const databaseUrl = String(process.env.DATABASE_URL || '')
	const dbMode = databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
		? 'cloud-postgres'
		: databaseUrl.startsWith('file:')
			? 'local-sqlite'
			: 'unknown'

	return NextResponse.json({
		currentUserId: session.user.id,
		role,
		restaurantId: context.restaurantId,
		branchId: context.branchId,
		billingUserId: context.billingUserId,
		dbMode,
		counts: {
			orderCount: totalOrders,
			paidOrderCount: paidOrders,
			pendingOrderCount: pendingOrders,
			accountingTransactionCount: totalTransactionCount,
			restaurantScopedTransactionCount,
		},
		lastOrder,
		lastPaidOrder,
		lastTransaction,
	})
}
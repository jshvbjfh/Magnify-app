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
		return NextResponse.json({ error: 'Admin or owner only' }, { status: 403 })
	}

	const context = await getRestaurantContextForUser(session.user.id)
	if (!context?.restaurantId || !context.branchId) {
		return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
	}

	const branchWhere = { restaurantId: context.restaurantId, branchId: context.branchId }

	const [
		totalOrders,
		paidOrders,
		pendingOrders,
		totalJournalEntryCount,
		restaurantScopedJournalEntryCount,
		lastOrder,
		lastPaidOrder,
		lastJournalEntry,
	] = await Promise.all([
		prisma.restaurantOrder.count({ where: branchWhere }),
		prisma.restaurantOrder.count({ where: { ...branchWhere, status: 'PAID' } }),
		prisma.restaurantOrder.count({ where: { ...branchWhere, status: 'PENDING' } }),
		prisma.journalEntry.count({ where: { restaurantId: context.restaurantId } }),
		prisma.journalEntry.count({ where: { restaurantId: context.restaurantId, branchId: context.branchId } }),
		prisma.restaurantOrder.findFirst({ where: branchWhere, orderBy: { createdAt: 'desc' }, select: { id: true, orderNumber: true, createdAt: true, status: true } }),
		prisma.restaurantOrder.findFirst({ where: { ...branchWhere, status: 'PAID' }, orderBy: { paidAt: 'desc' }, select: { id: true, orderNumber: true, paidAt: true, totalAmount: true, paymentMethod: true } }),
		prisma.journalEntry.findFirst({ where: { restaurantId: context.restaurantId }, orderBy: { createdAt: 'desc' }, select: { id: true, description: true, entryDate: true, branchId: true } }),
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
			accountingTransactionCount: totalJournalEntryCount,
			restaurantScopedTransactionCount: restaurantScopedJournalEntryCount,
		},
		lastOrder,
		lastPaidOrder,
		lastTransaction: lastJournalEntry,
	})
}

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { recordJournalEntry } from '@/lib/accounting'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'

export async function GET(_req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		return NextResponse.json({ payables: [], totalUnpaid: 0 })
	} catch (error: any) {
		return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
	}
}

export async function POST(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

		const { vendorName, description, amount, date } = await req.json()
		const missingFields = []
		if (!vendorName) missingFields.push('vendorName')
		if (!amount) missingFields.push('amount')
		if (missingFields.length > 0) return NextResponse.json({ error: `Missing required fields: ${missingFields.join(', ')}` }, { status: 400 })

		const ctx = getRestaurantContextFromSession(session.user as Record<string, unknown>)
		if (!ctx.restaurantId) return NextResponse.json({ error: 'No restaurant linked to this account' }, { status: 409 })

		const txDate = date ? new Date(date) : new Date()
		const fullDescription = `${description || 'Goods/services received'} - ${vendorName}`

		await recordJournalEntry(prisma, {
			restaurantId: ctx.restaurantId,
			date: txDate,
			description: fullDescription,
			amount: parseFloat(amount),
			direction: 'out',
			accountName: 'General Expense',
			paymentMethod: 'Credit',
		})

		return NextResponse.json({ success: true })
	} catch (error: any) {
		return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
	}
}

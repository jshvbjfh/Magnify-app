import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { recordJournalEntry } from '@/lib/accounting'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ receivables: [], totalUnpaid: 0 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { clientName, description, amount, date, serviceType } = await req.json()
    if (!clientName || !amount) return NextResponse.json({ error: 'clientName and amount required' }, { status: 400 })

    const ctx = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    if (!ctx.restaurantId) return NextResponse.json({ error: 'No restaurant linked' }, { status: 409 })

    const txDate = date ? new Date(date) : new Date()
    const fullDescription = `${serviceType || 'Service'}: ${description || clientName} - ${clientName}`

    await recordJournalEntry(prisma, {
      restaurantId: ctx.restaurantId,
      date: txDate,
      description: fullDescription,
      amount: parseFloat(amount),
      direction: 'in',
      accountName: 'Sales',
      paymentMethod: 'Credit',
    })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

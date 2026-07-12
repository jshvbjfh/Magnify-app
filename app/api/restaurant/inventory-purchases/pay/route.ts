import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ensureCoreCategories, ensureAccount, resolveSettlementAccount, normalizePaymentMethod } from '@/lib/accounting'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    const restaurantId = context?.restaurantId ?? null
    const branchId = context?.branchId ?? null
    if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant station found' }, { status: 400 })

    const body = await req.json()
    const { purchaseId, paymentMethod } = body
    if (!purchaseId) return NextResponse.json({ error: 'purchaseId is required' }, { status: 400 })

    const purchase = await prisma.inventoryPurchase.findFirst({
      where: { id: purchaseId, restaurantId, branchId },
      include: { ingredient: { select: { name: true, unit: true } } },
    })

    if (!purchase) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 })
    if (purchase.paymentMethod !== 'Credit') return NextResponse.json({ error: 'This purchase was not recorded as credit' }, { status: 400 })
    if (purchase.paidAt) return NextResponse.json({ error: 'This payable has already been cleared' }, { status: 409 })

    const normalizedPayMethod = normalizePaymentMethod(paymentMethod || 'Cash')

    const updated = await prisma.$transaction(async (tx) => {
      const categories = await ensureCoreCategories(tx, restaurantId)

      const apAccount = await ensureAccount(tx, {
        restaurantId,
        name: 'Accounts Payable',
        type: 'liability',
        categoryId: categories.liability.id,
        code: '2000',
      })

      const { account: cashAccount } = await resolveSettlementAccount(tx, normalizedPayMethod, 'out', categories, restaurantId)

      await tx.journalEntry.create({
        data: {
          restaurantId,
          branchId,
          description: `A/P Payment: ${purchase.ingredient.name}${purchase.supplier ? ` (${purchase.supplier})` : ''} via ${normalizedPayMethod}`,
          reference: `PAY-${purchase.id.slice(-8).toUpperCase()}`,
          entryDate: new Date(),
          lines: {
            create: [
              { accountId: apAccount.id, debit: purchase.totalCost, credit: 0, description: `Clear A/P: ${purchase.ingredient.name}` },
              { accountId: cashAccount.id, debit: 0, credit: purchase.totalCost, description: `A/P payment via ${normalizedPayMethod}` },
            ],
          },
        },
      })

      return tx.inventoryPurchase.update({
        where: { id: purchaseId },
        data: { paidAt: new Date() },
        include: { ingredient: { select: { name: true, unit: true } } },
      })
    }, { maxWait: 15000, timeout: 60000 })

    return NextResponse.json({ purchase: updated })
  } catch (error: any) {
    console.error('Failed to pay A/P entry:', error)
    return NextResponse.json({ error: error?.message || 'Failed to process payment' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'

import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { deleteTransactionForever } from '@/lib/transactionDeletion'

// Unwinding a settlement touches the ledger, the sales, the stock layers and
// the order, so it gets the same room as the payment that created it.
const DELETE_TRANSACTION_OPTIONS = { maxWait: 10000, timeout: 30000 } as const

export async function PATCH() {
  return NextResponse.json({ error: 'Transaction ledger has been replaced by journal entries' }, { status: 410 })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    if (!context.restaurantId) {
      return NextResponse.json({ error: 'No restaurant linked to this account.' }, { status: 400 })
    }

    // Waiters and kitchen screens share this API but never this page. Deleting a
    // settled bill erases it from every report, so it stays with whoever runs
    // the books rather than whoever happens to be signed in at a terminal.
    if (context.role === 'waiter' || context.role === 'kitchen') {
      return NextResponse.json({ error: 'Only a manager can delete a transaction.' }, { status: 403 })
    }

    const { id } = await params

    const result = await prisma.$transaction(
      (tx) => deleteTransactionForever(tx, { restaurantId: context.restaurantId as string, entryId: id }),
      DELETE_TRANSACTION_OPTIONS,
    )

    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.reason === 'not_found' ? 404 : 409 })
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('Failed to delete transaction:', error)
    return NextResponse.json({ error: 'Could not delete this transaction.' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { compare } from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import type { SyncSummaryPayload, SyncTransactionPayload } from '@/lib/minimalSync'

function matchesSharedSecret(input: string, expected: string) {
  return input.length > 0 && expected.length > 0 && input === expected
}

async function ensureSyncAccounts(restaurantId: string, syncRestaurantId: string) {
  let incomeCategory = await prisma.category.findFirst({ where: { restaurantId, name: 'Synced Sales Revenue' } })
  if (!incomeCategory) {
    incomeCategory = await prisma.category.create({
      data: { restaurantId, name: 'Synced Sales Revenue', type: 'income', description: 'Cloud-synced local restaurant sales' },
    })
  }

  let expenseCategory = await prisma.category.findFirst({ where: { restaurantId, name: 'Synced Operating Expense' } })
  if (!expenseCategory) {
    expenseCategory = await prisma.category.create({
      data: { restaurantId, name: 'Synced Operating Expense', type: 'expense', description: 'Cloud-synced local restaurant expenses' },
    })
  }

  const codeSuffix = syncRestaurantId.slice(-8).toUpperCase()

  let incomeAccount = await prisma.account.findFirst({ where: { restaurantId, name: 'Synced Sales' } })
  if (!incomeAccount) {
    incomeAccount = await prisma.account.create({
      data: {
        restaurantId,
        code: `SYNC-SALE-${codeSuffix}`,
        name: 'Synced Sales',
        categoryId: incomeCategory.id,
        type: 'revenue',
        description: 'Sales synced from local restaurant database',
      },
    })
  }

  let expenseAccount = await prisma.account.findFirst({ where: { restaurantId, name: 'Synced Expenses' } })
  if (!expenseAccount) {
    expenseAccount = await prisma.account.create({
      data: {
        restaurantId,
        code: `SYNC-EXP-${codeSuffix}`,
        name: 'Synced Expenses',
        categoryId: expenseCategory.id,
        type: 'expense',
        description: 'Expenses synced from local restaurant database',
      },
    })
  }

  return { incomeCategory, expenseCategory, incomeAccount, expenseAccount }
}

export async function POST(req: Request) {
  try {
    const email = req.headers.get('x-sync-email')?.trim().toLowerCase() ?? ''
    const sharedSecret = req.headers.get('x-sync-secret')?.trim() ?? ''
    const password = req.headers.get('x-sync-password') ?? ''
    if (!email || (!sharedSecret && !password)) {
      return NextResponse.json({ error: 'Sync credentials are required' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) return NextResponse.json({ error: 'Invalid sync credentials' }, { status: 401 })

    const configuredSharedSecret = process.env.OWNER_SYNC_SHARED_SECRET?.trim() ?? ''
    if (sharedSecret) {
      if (!matchesSharedSecret(sharedSecret, configuredSharedSecret)) {
        return NextResponse.json({ error: 'Invalid sync credentials' }, { status: 401 })
      }
    } else {
      const passwordOk = await compare(password, user.password)
      if (!passwordOk) return NextResponse.json({ error: 'Invalid sync credentials' }, { status: 401 })
    }

    const body = await req.json()
    const restaurantSyncId = String(body.restaurantSyncId ?? '').trim()
    const restaurantName = String(body.restaurantName ?? '').trim()
    const restaurantToken = String(body.restaurantToken ?? '')
    const transactions = (Array.isArray(body.transactions) ? body.transactions : []) as SyncTransactionPayload[]
    const summaries = (Array.isArray(body.summaries) ? body.summaries : []) as SyncSummaryPayload[]

    if (!restaurantSyncId || !restaurantToken) {
      return NextResponse.json({ error: 'restaurantSyncId and restaurantToken are required' }, { status: 400 })
    }

    let restaurant = await prisma.restaurant.findUnique({ where: { syncRestaurantId: restaurantSyncId } })
    if (!restaurant) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      let joinCode = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
      while (await prisma.restaurant.findUnique({ where: { joinCode } })) {
        joinCode = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
      }

      restaurant = await prisma.restaurant.create({
        data: {
          name: restaurantName || 'Synced Branch',
          ownerId: user.id,
          joinCode,
          syncRestaurantId: restaurantSyncId,
          syncToken: restaurantToken,
        },
      })
    }

    if (restaurant.ownerId !== user.id) {
      return NextResponse.json({ error: 'This branch is linked to a different owner account' }, { status: 403 })
    }

    if (restaurant.syncToken !== restaurantToken) {
      return NextResponse.json({ error: 'Invalid restaurant sync token' }, { status: 401 })
    }

    const { incomeCategory, expenseCategory, incomeAccount, expenseAccount } = await ensureSyncAccounts(restaurant.id, restaurantSyncId)

    for (const row of transactions) {
      await prisma.transaction.upsert({
        where: { id: row.id },
        update: {
          userId: user.id,
          restaurantId: restaurant.id,
          accountId: row.type === 'sale' ? incomeAccount.id : expenseAccount.id,
          categoryId: row.type === 'sale' ? incomeCategory.id : expenseCategory.id,
          date: new Date(row.createdAt),
          description: row.description,
          amount: row.amount,
          type: row.type === 'sale' ? 'credit' : 'debit',
          paymentMethod: 'Synced',
          isManual: true,
          synced: true,
        },
        create: {
          id: row.id,
          userId: user.id,
          restaurantId: restaurant.id,
          accountId: row.type === 'sale' ? incomeAccount.id : expenseAccount.id,
          categoryId: row.type === 'sale' ? incomeCategory.id : expenseCategory.id,
          date: new Date(row.createdAt),
          description: row.description,
          amount: row.amount,
          type: row.type === 'sale' ? 'credit' : 'debit',
          paymentMethod: 'Synced',
          isManual: true,
          synced: true,
        },
      })
    }

    for (const row of summaries) {
      await prisma.dailySummary.upsert({
        where: { id: row.id },
        update: {
          userId: user.id,
          restaurantId: restaurant.id,
          date: new Date(row.date),
          totalRevenue: row.totalRevenue,
          totalExpenses: row.totalExpenses,
          profitLoss: row.profitLoss,
          lastUpdated: new Date(row.lastUpdated),
          synced: true,
        },
        create: {
          id: row.id,
          userId: user.id,
          restaurantId: restaurant.id,
          date: new Date(row.date),
          totalRevenue: row.totalRevenue,
          totalExpenses: row.totalExpenses,
          profitLoss: row.profitLoss,
          lastUpdated: new Date(row.lastUpdated),
          synced: true,
        },
      })
    }

    return NextResponse.json({ ok: true, transactions: transactions.length, summaries: summaries.length })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync records' },
      { status: 500 }
    )
  }
}
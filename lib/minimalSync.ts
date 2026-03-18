import type { PrismaClient } from '@prisma/client'

type TransactionWithCategory = {
  id: string
  pairId: string | null
  amount: number
  description: string
  createdAt: Date
  date: Date
  category: {
    type: string
  }
}

export type SyncTransactionPayload = {
  id: string
  type: 'sale' | 'expense'
  amount: number
  description: string
  createdAt: string
  synced: boolean
}

export type SyncSummaryPayload = {
  id: string
  date: string
  totalRevenue: number
  totalExpenses: number
  profitLoss: number
  lastUpdated: string
  synced: boolean
}

export type SyncEnvelopePayload = {
  restaurantSyncId: string
  restaurantName: string
  restaurantToken: string
  transactions: SyncTransactionPayload[]
  summaries: SyncSummaryPayload[]
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function endOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 23, 59, 59, 999)
}

function toDateKey(value: Date) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function buildSyncTransactions(rows: TransactionWithCategory[]) {
  const groups = new Map<string, TransactionWithCategory[]>()
  for (const row of rows) {
    const key = row.pairId ?? row.id
    const current = groups.get(key) ?? []
    current.push(row)
    groups.set(key, current)
  }

  const syncTransactions: SyncTransactionPayload[] = []
  const syncedIds: string[] = []

  for (const groupRows of groups.values()) {
    const primary = groupRows.find((row) => row.category.type === 'income')
      ?? groupRows.find((row) => row.category.type === 'expense')

    if (primary) {
      syncTransactions.push({
        id: primary.id,
        type: primary.category.type === 'income' ? 'sale' : 'expense',
        amount: primary.amount,
        description: primary.description,
        createdAt: primary.createdAt.toISOString(),
        synced: false,
      })
    }

    syncedIds.push(...groupRows.map((row) => row.id))
  }

  return { transactions: syncTransactions, syncedIds }
}

export async function refreshDailySummaries(prisma: PrismaClient, userId: string, dateKeys: string[], restaurantId?: string | null) {
  const uniqueDateKeys = Array.from(new Set(dateKeys))
  if (uniqueDateKeys.length === 0) return []

  const summaries: string[] = []

  for (const dateKey of uniqueDateKeys) {
    const dayStart = startOfDay(new Date(`${dateKey}T12:00:00`))
    const dayEnd = endOfDay(dayStart)
    const dayTransactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: { gte: dayStart, lte: dayEnd },
        category: { is: { type: { in: ['income', 'expense'] } } },
      },
      include: { category: { select: { type: true } } },
    })

    let totalRevenue = 0
    let totalExpenses = 0
    const groups = new Map<string, typeof dayTransactions>()

    for (const row of dayTransactions) {
      const key = row.pairId ?? row.id
      const current = groups.get(key) ?? []
      current.push(row)
      groups.set(key, current)
    }

    for (const groupRows of groups.values()) {
      const primary = groupRows.find((row) => row.category.type === 'income')
        ?? groupRows.find((row) => row.category.type === 'expense')
      if (!primary) continue

      if (primary.category.type === 'income') totalRevenue += primary.amount
      if (primary.category.type === 'expense') totalExpenses += primary.amount
    }

    const existing = await prisma.dailySummary.findFirst({
      where: {
        userId,
        restaurantId: restaurantId ?? null,
        date: dayStart,
      },
      select: { id: true },
    })

    if (existing) {
      await prisma.dailySummary.update({
        where: { id: existing.id },
        data: {
          totalRevenue,
          totalExpenses,
          profitLoss: totalRevenue - totalExpenses,
          synced: false,
          restaurantId: restaurantId ?? null,
        },
      })
    } else {
      await prisma.dailySummary.create({
        data: {
          userId,
          restaurantId: restaurantId ?? null,
          date: dayStart,
          totalRevenue,
          totalExpenses,
          profitLoss: totalRevenue - totalExpenses,
          synced: false,
        },
      })
    }

    summaries.push(dateKey)
  }

  return summaries
}

export function mapSummaryPayload(rows: Array<{
  id: string
  date: Date
  totalRevenue: number
  totalExpenses: number
  profitLoss: number
  lastUpdated: Date
  synced: boolean
}>) {
  return rows.map((row) => ({
    id: row.id,
    date: row.date.toISOString(),
    totalRevenue: row.totalRevenue,
    totalExpenses: row.totalExpenses,
    profitLoss: row.profitLoss,
    lastUpdated: row.lastUpdated.toISOString(),
    synced: row.synced,
  })) satisfies SyncSummaryPayload[]
}

export function normalizeTargetUrl(value: string) {
  return value.trim().replace(/\/$/, '')
}
import type { PrismaClient } from '@prisma/client'

import { createHash } from 'crypto'

import { isCashEquivalentAccountName } from '@/lib/restaurantReporting'
import type { SyncChangeEnvelope } from '@/lib/syncOutbox'

type TransactionWithCategory = {
  id: string
  pairId: string | null
  amount: number
  description: string
  createdAt: Date
  date: Date
  paymentMethod: string
  sourceKind: string | null
  isManual: boolean
  authoritativeForRevenue: boolean
  account: {
    name: string
  } | null
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
  paymentMethod: string
  accountName: string | null
  sourceKind: string | null
  isManual: boolean
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
  batchId: string
  payloadHash: string
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
  const year = value.getUTCFullYear()
  const month = String(value.getUTCMonth() + 1).padStart(2, '0')
  const day = String(value.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isWasteLikeTransaction(row: { sourceKind?: string | null; description: string }) {
  const normalizedSourceKind = String(row.sourceKind || '').trim().toLowerCase()
  if (normalizedSourceKind === 'inventory_waste') return true
  return row.description.trim().toLowerCase().startsWith('waste:')
}

function numbersMatch(left: number, right: number) {
  return Math.abs(left - right) < 0.0001
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

    if (primary && !(primary.category.type === 'income' && primary.authoritativeForRevenue === false)) {
      syncTransactions.push({
        id: primary.id,
        type: primary.category.type === 'income' ? 'sale' : 'expense',
        amount: primary.amount,
        description: primary.description,
        createdAt: primary.createdAt.toISOString(),
        paymentMethod: primary.paymentMethod,
        accountName: primary.account?.name ?? null,
        sourceKind: primary.sourceKind,
        isManual: primary.isManual,
        synced: false,
      })
    }

    syncedIds.push(...groupRows.map((row) => row.id))
  }

  return { transactions: syncTransactions, syncedIds }
}

export async function refreshDailySummaries(prisma: PrismaClient, userId: string, dateKeys: string[], restaurantId?: string | null, branchId?: string | null) {
  const uniqueDateKeys = Array.from(new Set(dateKeys))
  if (uniqueDateKeys.length === 0) return []

  const summaries: string[] = []

  for (const dateKey of uniqueDateKeys) {
    // Parse in local time for querying — transactions are stored in the same local timezone
    const dayStart = startOfDay(new Date(`${dateKey}T12:00:00`))
    const dayEnd = endOfDay(new Date(`${dateKey}T12:00:00`))
    // UTC noon for storage — immune to timezone shifts when synced to cloud
    const daySummaryDate = new Date(`${dateKey}T12:00:00Z`)
    const dayTransactions = await prisma.transaction.findMany({
      where: {
        userId,
        ...(restaurantId !== undefined ? { restaurantId: restaurantId ?? null } : {}),
        ...(branchId !== undefined ? { branchId: branchId ?? null } : {}),
        date: { gte: dayStart, lte: dayEnd },
        category: { is: { type: { in: ['income', 'expense'] } } },
      },
      include: { category: { select: { type: true } }, account: { select: { name: true } } },
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
      if (groupRows.some((row) => isWasteLikeTransaction(row))) {
        continue
      }

      // For each transaction pair, find the cash-equivalent leg to match the desktop view.
      const cashLeg = groupRows.find((row) => isCashEquivalentAccountName(row.account?.name ?? ''))
      if (cashLeg) {
        if (cashLeg.type === 'debit') totalRevenue += cashLeg.amount
        if (cashLeg.type === 'credit') totalExpenses += cashLeg.amount
      } else {
        // Fallback: use income/expense category classification.
        const primary = groupRows.find((row) => row.category.type === 'income')
          ?? groupRows.find((row) => row.category.type === 'expense')
        if (!primary) continue
        if (primary.category.type === 'income') totalRevenue += primary.amount
        if (primary.category.type === 'expense') totalExpenses += primary.amount
      }
    }

    const profitLoss = totalRevenue - totalExpenses

    const existing = await prisma.dailySummary.findFirst({
      where: {
        userId,
        restaurantId: restaurantId ?? null,
        branchId: branchId ?? null,
        // Match summaries stored at either old local-midnight or new UTC-noon
        date: { gte: new Date(`${dateKey}T00:00:00Z`), lte: new Date(`${dateKey}T23:59:59.999Z`) },
      },
      select: {
        id: true,
        date: true,
        totalRevenue: true,
        totalExpenses: true,
        profitLoss: true,
      },
    })

    if (existing) {
      const summaryChanged = existing.date.getTime() !== daySummaryDate.getTime()
        || !numbersMatch(existing.totalRevenue, totalRevenue)
        || !numbersMatch(existing.totalExpenses, totalExpenses)
        || !numbersMatch(existing.profitLoss, profitLoss)

      if (summaryChanged) {
        await prisma.dailySummary.update({
          where: { id: existing.id },
          data: {
            totalRevenue,
            totalExpenses,
            profitLoss,
            date: daySummaryDate,
            synced: false,
            restaurantId: restaurantId ?? null,
            branchId: branchId ?? null,
          },
        })
      }
    } else {
      await prisma.dailySummary.create({
        data: {
          userId,
          restaurantId: restaurantId ?? null,
          branchId: branchId ?? null,
          date: daySummaryDate,
          totalRevenue,
          totalExpenses,
          profitLoss,
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
    date: toDateKey(row.date) + 'T12:00:00.000Z',
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

export function buildSyncBatchSignature(payload: { restaurantSyncId: string; transactions: SyncTransactionPayload[]; summaries: SyncSummaryPayload[] }) {
  const normalized = JSON.stringify({
    restaurantSyncId: payload.restaurantSyncId,
    transactions: [...payload.transactions]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        type: row.type,
        amount: row.amount,
        description: row.description,
        createdAt: row.createdAt,
        paymentMethod: row.paymentMethod,
        accountName: row.accountName,
        sourceKind: row.sourceKind,
        isManual: row.isManual,
      })),
    summaries: [...payload.summaries]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => ({ id: row.id, date: row.date, totalRevenue: row.totalRevenue, totalExpenses: row.totalExpenses, profitLoss: row.profitLoss, lastUpdated: row.lastUpdated })),
  })

  const payloadHash = createHash('sha256').update(normalized).digest('hex')
  return {
    batchId: `sync-${payloadHash.slice(0, 24)}`,
    payloadHash,
  }
}

export function buildHybridSyncBatchSignature(payload: {
  restaurantSyncId: string
  transactions: SyncTransactionPayload[]
  summaries: SyncSummaryPayload[]
  changes: SyncChangeEnvelope[]
}) {
  const normalized = JSON.stringify({
    restaurantSyncId: payload.restaurantSyncId,
    transactions: [...payload.transactions]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        type: row.type,
        amount: row.amount,
        description: row.description,
        createdAt: row.createdAt,
        paymentMethod: row.paymentMethod,
        accountName: row.accountName,
        sourceKind: row.sourceKind,
        isManual: row.isManual,
      })),
    summaries: [...payload.summaries]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => ({ id: row.id, date: row.date, totalRevenue: row.totalRevenue, totalExpenses: row.totalExpenses, profitLoss: row.profitLoss, lastUpdated: row.lastUpdated })),
    changes: [...payload.changes]
      .sort((a, b) => a.mutationId.localeCompare(b.mutationId))
      .map((row) => ({
        mutationId: row.mutationId,
        scopeId: row.scopeId,
        restaurantId: row.restaurantId,
        entityType: row.entityType,
        entityId: row.entityId,
        operation: row.operation,
        sourceDeviceId: row.sourceDeviceId,
        createdAt: row.createdAt,
        payload: row.payload,
      })),
  })

  const payloadHash = createHash('sha256').update(normalized).digest('hex')
  return {
    batchId: `sync-${payloadHash.slice(0, 24)}`,
    payloadHash,
  }
}
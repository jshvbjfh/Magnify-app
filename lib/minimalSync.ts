import type { PrismaClient } from '@prisma/client'

import { createHash, randomBytes } from 'crypto'

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

function kigaliDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(date)
}

function startOfDay(value: Date) {
  // Use noon of the given date in Kigali to resolve the correct local date, then take midnight Kigali
  const key = kigaliDateKey(value)
  return new Date(`${key}T00:00:00+02:00`)
}

function endOfDay(value: Date) {
  const key = kigaliDateKey(value)
  return new Date(`${key}T23:59:59.999+02:00`)
}

function toDateKey(value: Date) {
  return kigaliDateKey(value)
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
        createdAt: primary.date.toISOString(),
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

export async function refreshDailySummaries(_prisma: PrismaClient, _userId: string, _dateKeys: string[], _restaurantId?: string | null, _branchId?: string | null): Promise<string[]> {
  return []
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
  // Add a random nonce so each sync attempt generates a unique batchId.
  // Without a nonce, an empty payload (no transactions/summaries/changes) always
  // hashes to the same value — the first successful empty sync permanently stores
  // that batchId as 'success', causing every subsequent sync to hit the dedup guard
  // and return "already applied" forever (0 records visible in manager portal).
  // All cloud upserts are idempotent by entity id, so re-processing is safe.
  const nonce = randomBytes(4).toString('hex')
  return {
    batchId: `sync-${payloadHash.slice(0, 16)}-${nonce}`,
    payloadHash,
  }
}
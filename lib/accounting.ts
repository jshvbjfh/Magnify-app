import type { Prisma, PrismaClient } from '@prisma/client'

type PrismaDb = PrismaClient | Prisma.TransactionClient

type CategoryRecord = { id: string; type: string; name: string }
type CategoryMap = Record<string, CategoryRecord>

// ─── Helpers ────────────────────────────────────────────────────────────────

export function normalizePaymentMethod(paymentMethod?: string): string {
  const raw = String(paymentMethod || 'Cash').trim().toLowerCase()
  if (raw.includes('internal')) return 'Internal'
  if (raw.includes('note')) return 'Notes Payable'
  if (raw === 'credit' || raw.includes('accounts payable') || raw.includes('payable')) return 'Credit'
  if (raw.includes('cheque') || raw.includes('check')) return 'Cheque'
  if (raw.includes('mobile') || raw.includes('momo')) return raw.includes('owner') ? 'Owner Momo' : 'Mobile Money'
  if (raw.includes('card')) return 'Card'
  if (raw.includes('bank') || raw.includes('transfer') || raw.includes('current account')) return 'Bank'
  return 'Cash'
}

function makeAutoCode(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase()
}

function resolveAccountType(categoryType: string) {
  if (categoryType === 'income') return 'revenue'
  if (categoryType === 'expense') return 'expense'
  return categoryType
}

// ─── Category / Account provisioning ────────────────────────────────────────

export async function ensureCoreCategories(db: PrismaDb, restaurantId: string | null = null) {
  const types = ['income', 'expense', 'asset', 'liability', 'equity'] as const
  const byType: CategoryMap = {}

  // One batched read covers the steady state (all five already exist);
  // writes only happen on first use or if a stored type drifted.
  const names = types.map((type) => type.charAt(0).toUpperCase() + type.slice(1))
  const existing = await db.category.findMany({ where: { restaurantId, name: { in: names } } })
  const existingByName = new Map(existing.map((category) => [category.name, category]))

  for (const type of types) {
    const name = type.charAt(0).toUpperCase() + type.slice(1)
    const found = existingByName.get(name)
    if (found && found.type === type) {
      byType[type] = found
    } else if (found) {
      byType[type] = await db.category.update({ where: { id: found.id }, data: { type } })
    } else {
      byType[type] = await db.category.create({ data: { restaurantId, name, type } })
    }
  }

  return byType
}

export async function ensureAccount(
  db: PrismaDb,
  params: { restaurantId?: string | null; name: string; type: string; categoryId: string; code?: string },
) {
  const restaurantId = params.restaurantId ?? null
  const existing = await db.account.findFirst({ where: { restaurantId, name: params.name } })
  if (existing) return existing

  return db.account.create({
    data: {
      restaurantId,
      code: params.code || makeAutoCode('AUTO'),
      name: params.name,
      type: params.type,
      categoryId: params.categoryId,
    },
  })
}

type SettlementAccountSpec = {
  paymentMethod: string
  name: string
  type: string
  categoryId: string
  code: string
}

export function resolveSettlementAccountSpec(
  paymentMethod: string,
  direction: 'in' | 'out',
  categories: CategoryMap,
): SettlementAccountSpec {
  const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod)

  if (normalizedPaymentMethod === 'Internal') {
    throw new Error('Internal journal entries require an explicit counter account')
  }

  if (direction === 'out' && normalizedPaymentMethod === 'Credit') {
    return { paymentMethod: normalizedPaymentMethod, name: 'Accounts Payable', type: 'liability', categoryId: categories.liability.id, code: '2000' }
  }
  if (direction === 'out' && normalizedPaymentMethod === 'Notes Payable') {
    return { paymentMethod: normalizedPaymentMethod, name: 'Notes Payable', type: 'liability', categoryId: categories.liability.id, code: '2100' }
  }
  if (direction === 'in' && normalizedPaymentMethod === 'Credit') {
    return { paymentMethod: normalizedPaymentMethod, name: 'Accounts Receivable', type: 'asset', categoryId: categories.asset.id, code: '1200' }
  }
  if (normalizedPaymentMethod === 'Card' || normalizedPaymentMethod === 'Bank' || normalizedPaymentMethod === 'Cheque') {
    return { paymentMethod: normalizedPaymentMethod, name: 'Current Account', type: 'asset', categoryId: categories.asset.id, code: '1010' }
  }
  if (normalizedPaymentMethod === 'Mobile Money') {
    return { paymentMethod: normalizedPaymentMethod, name: 'Mobile Money', type: 'asset', categoryId: categories.asset.id, code: '1020' }
  }
  if (normalizedPaymentMethod === 'Owner Momo') {
    return { paymentMethod: normalizedPaymentMethod, name: 'Owner Momo', type: 'asset', categoryId: categories.asset.id, code: '1021' }
  }
  return { paymentMethod: 'Cash', name: 'Cash', type: 'asset', categoryId: categories.asset.id, code: '1000' }
}

export async function resolveSettlementAccount(
  db: PrismaDb,
  paymentMethod: string,
  direction: 'in' | 'out',
  categories: CategoryMap,
  restaurantId: string | null = null,
) {
  const spec = resolveSettlementAccountSpec(paymentMethod, direction, categories)
  return {
    paymentMethod: spec.paymentMethod,
    account: await ensureAccount(db, {
      restaurantId, name: spec.name, type: spec.type,
      categoryId: spec.categoryId, code: spec.code,
    }),
  }
}

// ─── Journal entry recording ─────────────────────────────────────────────────
//
// Creates one JournalEntry with two JournalLines (proper double-entry).
// direction 'out' (expense): DR mainAccount, CR counterAccount
// direction 'in'  (revenue): DR counterAccount, CR mainAccount

export async function recordJournalEntry(
  db: PrismaDb,
  params: {
    restaurantId?: string | null
    branchId?: string | null
    date: Date
    description: string
    reference?: string | null
    amount: number
    direction: 'in' | 'out'
    accountName?: string
    categoryType?: string
    paymentMethod?: string
    counterAccountName?: string
    counterCategoryType?: string
    counterAccountType?: string
  },
) {
  const restaurantId = params.restaurantId ?? null
  if (!restaurantId) return null

  const direction = params.direction
  const categoryType = params.categoryType || (direction === 'out' ? 'expense' : 'income')
  const categories = await ensureCoreCategories(db, restaurantId)

  const mainCategory = categories[categoryType] || categories.expense
  const mainAccountType = resolveAccountType(mainCategory.type)
  const mainAccountName =
    params.accountName || (mainCategory.type === 'income' ? 'Sales' : 'General Expense')

  const explicitCounterAccountName = params.counterAccountName?.trim()
  const mainPaymentMethod = explicitCounterAccountName
    ? params.paymentMethod?.trim() || 'Internal'
    : params.paymentMethod || 'Cash'

  // Resolve both account specs up front so the pair can be fetched in one query;
  // creates only run for accounts that don't exist yet.
  const counterCategory = categories[params.counterCategoryType || 'asset'] || categories.asset
  const counterSpec = explicitCounterAccountName
    ? {
        name: explicitCounterAccountName,
        type: params.counterAccountType || resolveAccountType(counterCategory.type),
        categoryId: counterCategory.id,
        code: undefined as string | undefined,
      }
    : resolveSettlementAccountSpec(mainPaymentMethod, direction, categories)

  const accountNames = counterSpec.name === mainAccountName ? [mainAccountName] : [mainAccountName, counterSpec.name]
  const foundAccounts = await db.account.findMany({ where: { restaurantId, name: { in: accountNames } } })

  const mainAccount =
    foundAccounts.find((account) => account.name === mainAccountName) ??
    (await db.account.create({
      data: {
        restaurantId,
        code: makeAutoCode('AUTO'),
        name: mainAccountName,
        type: mainAccountType,
        categoryId: mainCategory.id,
      },
    }))

  const counterAccount = counterSpec.name === mainAccountName
    ? mainAccount
    : foundAccounts.find((account) => account.name === counterSpec.name) ??
      (await db.account.create({
        data: {
          restaurantId,
          code: counterSpec.code || makeAutoCode('AUTO'),
          name: counterSpec.name,
          type: counterSpec.type,
          categoryId: counterSpec.categoryId,
        },
      }))

  // direction 'out': DR main (expense), CR counter (cash/bank/liability)
  // direction 'in':  DR counter (cash/bank/asset), CR main (revenue)
  const [drAccount, crAccount] =
    direction === 'out'
      ? [mainAccount, counterAccount]
      : [counterAccount, mainAccount]

  const journalEntry = await db.journalEntry.create({
    data: {
      restaurantId,
      branchId: params.branchId ?? null,
      description: params.description,
      reference: params.reference ?? null,
      entryDate: params.date,
      lines: {
        create: [
          {
            accountId: drAccount.id,
            debit: params.amount,
            credit: 0,
            description: params.description,
          },
          {
            accountId: crAccount.id,
            debit: 0,
            credit: params.amount,
            description: params.description,
          },
        ],
      },
    },
  })

  return journalEntry
}

// ─── VAT journal entry (3 lines) ────────────────────────────────────────────
//
// Income with VAT: DR settlement (net + VAT), CR revenue (net), CR VAT Payable (VAT)
// The caller passes the NET amount; total received from customer = net × (1 + rate).

export async function recordVatJournalEntry(
  db: PrismaDb,
  params: {
    restaurantId: string
    branchId?: string | null
    date: Date
    description: string
    reference?: string | null
    netAmount: number
    vatRate?: number
    paymentMethod?: string
    accountName?: string
  },
) {
  const vatRate = params.vatRate ?? 0.18
  const net = Math.round(params.netAmount * 100) / 100
  const vat = Math.round(net * vatRate * 100) / 100
  const total = net + vat

  const categories = await ensureCoreCategories(db, params.restaurantId)

  const settlement = await resolveSettlementAccount(
    db, params.paymentMethod || 'Cash', 'in', categories, params.restaurantId,
  )

  const revenueAccount = await ensureAccount(db, {
    restaurantId: params.restaurantId,
    name: params.accountName || 'Sales',
    type: 'revenue',
    categoryId: categories.income.id,
  })

  const vatAccount = await ensureAccount(db, {
    restaurantId: params.restaurantId,
    name: 'VAT Payable',
    type: 'liability',
    categoryId: categories.liability.id,
    code: '2200',
  })

  return db.journalEntry.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: params.branchId ?? null,
      description: params.description,
      reference: params.reference ?? null,
      entryDate: params.date,
      lines: {
        create: [
          { accountId: settlement.account.id, debit: total,  credit: 0,   description: params.description },
          { accountId: revenueAccount.id,      debit: 0,     credit: net,  description: params.description },
          { accountId: vatAccount.id,           debit: 0,     credit: vat,  description: params.description },
        ],
      },
    },
  })
}

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

  for (const type of types) {
    const name = type.charAt(0).toUpperCase() + type.slice(1)
    const category = await db.category.upsert({
      where: { restaurantId_name: { restaurantId: restaurantId as unknown as string, name } },
      update: { type },
      create: { restaurantId, name, type },
    })
    byType[type] = category
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

export async function resolveSettlementAccount(
  db: PrismaDb,
  paymentMethod: string,
  direction: 'in' | 'out',
  categories: CategoryMap,
  restaurantId: string | null = null,
) {
  const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod)

  if (normalizedPaymentMethod === 'Internal') {
    throw new Error('Internal journal entries require an explicit counter account')
  }

  if (direction === 'out') {
    if (normalizedPaymentMethod === 'Credit') {
      return {
        paymentMethod: normalizedPaymentMethod,
        account: await ensureAccount(db, {
          restaurantId, name: 'Accounts Payable', type: 'liability',
          categoryId: categories.liability.id, code: '2000',
        }),
      }
    }
    if (normalizedPaymentMethod === 'Notes Payable') {
      return {
        paymentMethod: normalizedPaymentMethod,
        account: await ensureAccount(db, {
          restaurantId, name: 'Notes Payable', type: 'liability',
          categoryId: categories.liability.id, code: '2100',
        }),
      }
    }
  }

  if (direction === 'in' && normalizedPaymentMethod === 'Credit') {
    return {
      paymentMethod: normalizedPaymentMethod,
      account: await ensureAccount(db, {
        restaurantId, name: 'Accounts Receivable', type: 'asset',
        categoryId: categories.asset.id, code: '1200',
      }),
    }
  }

  if (normalizedPaymentMethod === 'Bank' || normalizedPaymentMethod === 'Cheque') {
    return {
      paymentMethod: normalizedPaymentMethod,
      account: await ensureAccount(db, {
        restaurantId, name: 'Current Account', type: 'asset',
        categoryId: categories.asset.id, code: '1010',
      }),
    }
  }

  if (normalizedPaymentMethod === 'Mobile Money') {
    return {
      paymentMethod: normalizedPaymentMethod,
      account: await ensureAccount(db, {
        restaurantId, name: 'Mobile Money', type: 'asset',
        categoryId: categories.asset.id, code: '1020',
      }),
    }
  }

  if (normalizedPaymentMethod === 'Owner Momo') {
    return {
      paymentMethod: normalizedPaymentMethod,
      account: await ensureAccount(db, {
        restaurantId, name: 'Owner Momo', type: 'asset',
        categoryId: categories.asset.id, code: '1021',
      }),
    }
  }

  return {
    paymentMethod: 'Cash',
    account: await ensureAccount(db, {
      restaurantId, name: 'Cash', type: 'asset',
      categoryId: categories.asset.id, code: '1000',
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
  const mainAccount = await ensureAccount(db, {
    restaurantId,
    name: mainAccountName,
    type: mainAccountType,
    categoryId: mainCategory.id,
  })

  const explicitCounterAccountName = params.counterAccountName?.trim()
  const mainPaymentMethod = explicitCounterAccountName
    ? params.paymentMethod?.trim() || 'Internal'
    : params.paymentMethod || 'Cash'

  const settlement = explicitCounterAccountName
    ? null
    : await resolveSettlementAccount(db, mainPaymentMethod, direction, categories, restaurantId)

  const counterCategoryType = params.counterCategoryType ||
    (settlement?.account.type ? settlement.account.type : 'asset')
  const counterCategory = explicitCounterAccountName
    ? (categories[counterCategoryType] || categories.asset)
    : null
  const counterAccount = explicitCounterAccountName
    ? await ensureAccount(db, {
        restaurantId,
        name: explicitCounterAccountName,
        type: params.counterAccountType || resolveAccountType(counterCategory?.type || 'asset'),
        categoryId: (counterCategory || categories.asset).id,
      })
    : settlement!.account

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

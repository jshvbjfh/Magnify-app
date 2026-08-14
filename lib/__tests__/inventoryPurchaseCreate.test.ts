import { beforeEach, describe, expect, it, vi } from 'vitest'

const getServerSessionMock = vi.hoisted(() => vi.fn())
const getRestaurantContextFromSessionMock = vi.hoisted(() => vi.fn())

const txMock = vi.hoisted(() => ({
  inventoryItem: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  inventoryPurchase: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  category: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  account: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
  journalEntry: {
    create: vi.fn(),
  },
  syncOutbox: {
    create: vi.fn(),
  },
}))

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  restaurant: {
    findUnique: vi.fn(),
  },
  branch: {
    findFirst: vi.fn(),
  },
  inventoryPurchase: {
    findFirst: vi.fn(),
  },
  inventoryItem: {
    findFirst: vi.fn(),
  },
}))

vi.mock('next-auth', () => ({
  getServerSession: getServerSessionMock,
}))

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}))

vi.mock('@/lib/restaurantAccess', () => ({
  getRestaurantContextFromSession: getRestaurantContextFromSessionMock,
}))

vi.mock('@/lib/prisma', () => ({
  prisma: prismaMock,
}))

import { POST as postInventoryPurchase } from '@/app/api/restaurant/inventory-purchases/route'

const CLIENT_ID = 'entry-abc12345'

const coreCategories = [
  { id: 'cat-income', restaurantId: 'rest-1', name: 'Income', type: 'income' },
  { id: 'cat-expense', restaurantId: 'rest-1', name: 'Expense', type: 'expense' },
  { id: 'cat-asset', restaurantId: 'rest-1', name: 'Asset', type: 'asset' },
  { id: 'cat-liability', restaurantId: 'rest-1', name: 'Liability', type: 'liability' },
  { id: 'cat-equity', restaurantId: 'rest-1', name: 'Equity', type: 'equity' },
]

const coreAccounts = [
  { id: 'acc-main', restaurantId: 'rest-1', name: 'Inventory Purchases', type: 'expense', categoryId: 'cat-expense' },
  { id: 'acc-cash', restaurantId: 'rest-1', name: 'Cash', type: 'asset', categoryId: 'cat-asset' },
]

const oilIngredient = {
  id: 'ing-1',
  restaurantId: 'rest-1',
  branchId: 'branch-main',
  name: 'Cooking Oil',
  unit: 'L',
  unitCost: 100,
  quantity: 5,
}

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/restaurant/inventory-purchases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    id: CLIENT_ID,
    batchId: 'BAT-20260713-A',
    ingredientId: 'ing-1',
    itemName: 'Cooking Oil',
    unit: 'L',
    purchaseUnit: 'L',
    unitsPerPurchaseUnit: 1,
    paymentMethod: 'Cash',
    purchaseQuantity: 20,
    purchaseUnitCost: 100,
    purchasedAt: '2026-07-13',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()

  getServerSessionMock.mockResolvedValue({ user: { id: 'user-1' } })
  getRestaurantContextFromSessionMock.mockReturnValue({ restaurantId: 'rest-1', branchId: 'branch-main' })

  prismaMock.$transaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock))
  // Per-station stock unless a test says otherwise — today's behaviour.
  prismaMock.restaurant.findUnique.mockResolvedValue({ sharedStock: false })

  txMock.inventoryItem.findFirst.mockResolvedValue(oilIngredient)
  txMock.inventoryItem.update.mockResolvedValue({ ...oilIngredient, quantity: 25 })
  txMock.category.findMany.mockResolvedValue(coreCategories)
  txMock.account.findMany.mockResolvedValue(coreAccounts)
  txMock.journalEntry.create.mockImplementation(async ({ data }: any) => ({ id: 'je-1', ...data }))
  txMock.inventoryPurchase.create.mockImplementation(async ({ data }: any) => ({ id: data.id ?? 'purchase-server-id', ...data }))
  // One open layer (the new purchase) whose cost matches the item — no cost rewrite needed.
  txMock.inventoryPurchase.findMany.mockResolvedValue([
    { id: CLIENT_ID, remainingQuantity: 20, unitCost: 100, purchasedAt: new Date('2026-07-13'), createdAt: new Date('2026-07-13') },
  ])
  txMock.syncOutbox.create.mockResolvedValue({ id: 'outbox-1' })
})

describe('POST /api/restaurant/inventory-purchases', () => {
  it('creates the purchase under the client-generated id', async () => {
    const response = await postInventoryPurchase(makeRequest(makeBody()))

    expect(response.status).toBe(201)
    expect(txMock.inventoryPurchase.create).toHaveBeenCalledTimes(1)
    const createArgs = txMock.inventoryPurchase.create.mock.calls[0][0]
    expect(createArgs.data.id).toBe(CLIENT_ID)
    expect(createArgs.data.branchId).toBe('branch-main')

    const payload = await response.json()
    expect(payload.purchase.id).toBe(CLIENT_ID)
    expect(payload.ingredient.quantity).toBe(25)
  })

  it('uses batched category and account lookups with no writes in the steady state', async () => {
    await postInventoryPurchase(makeRequest(makeBody()))

    expect(txMock.category.findMany).toHaveBeenCalledTimes(1)
    expect(txMock.category.create).not.toHaveBeenCalled()
    expect(txMock.category.update).not.toHaveBeenCalled()
    expect(txMock.account.findMany).toHaveBeenCalledTimes(1)
    expect(txMock.account.create).not.toHaveBeenCalled()

    // Balanced double-entry: debit expense, credit cash, same amount.
    const journalArgs = txMock.journalEntry.create.mock.calls[0][0]
    const lines = journalArgs.data.lines.create
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ accountId: 'acc-main', debit: 2000, credit: 0 })
    expect(lines[1]).toMatchObject({ accountId: 'acc-cash', debit: 0, credit: 2000 })
  })

  it('returns the committed entry instead of failing when a saved entry is replayed', async () => {
    const committedPurchase = {
      id: CLIENT_ID,
      restaurantId: 'rest-1',
      branchId: 'branch-main',
      ingredientId: 'ing-1',
      batchId: 'BAT-20260713-A',
      totalCost: 2000,
      ingredient: { name: 'Cooking Oil', unit: 'L' },
    }
    txMock.inventoryPurchase.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))
    prismaMock.inventoryPurchase.findFirst.mockResolvedValue(committedPurchase)
    prismaMock.inventoryItem.findFirst.mockResolvedValue({ ...oilIngredient, quantity: 25 })

    const response = await postInventoryPurchase(makeRequest(makeBody()))

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.alreadySaved).toBe(true)
    expect(payload.purchase.id).toBe(CLIENT_ID)
    expect(prismaMock.inventoryPurchase.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: CLIENT_ID, restaurantId: 'rest-1' },
    }))
  })

  it('stamps a valid requested station onto the entry', async () => {
    prismaMock.branch.findFirst.mockResolvedValue({ id: 'branch-bar' })

    const response = await postInventoryPurchase(makeRequest(makeBody({ branchId: 'branch-bar' })))

    expect(response.status).toBe(201)
    expect(prismaMock.branch.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'branch-bar', restaurantId: 'rest-1', isActive: true },
    }))
    const createArgs = txMock.inventoryPurchase.create.mock.calls[0][0]
    expect(createArgs.data.branchId).toBe('branch-bar')
  })

  it('rejects an entry stamped with an unknown station', async () => {
    prismaMock.branch.findFirst.mockResolvedValue(null)

    const response = await postInventoryPurchase(makeRequest(makeBody({ branchId: 'branch-unknown' })))

    expect(response.status).toBe(400)
    const payload = await response.json()
    expect(payload.error).toBe('Station not found for this entry')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('stores an entered expiry date', async () => {
    await postInventoryPurchase(makeRequest(makeBody({ expiresAt: '2026-09-30' })))

    expect(txMock.inventoryPurchase.create.mock.calls[0][0].data.expiresAt).toEqual(new Date('2026-09-30'))
  })

  it('leaves the expiry null when the field was skipped', async () => {
    await postInventoryPurchase(makeRequest(makeBody()))

    expect(txMock.inventoryPurchase.create.mock.calls[0][0].data.expiresAt).toBeNull()
  })

  it('rejects an unreadable expiry date', async () => {
    const response = await postInventoryPurchase(makeRequest(makeBody({ expiresAt: 'not-a-date' })))

    expect(response.status).toBe(400)
    const payload = await response.json()
    expect(payload.error).toBe('Expiry must be a valid date')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('files the purchase under the main station when stock is shared', async () => {
    // Whoever records it and wherever they are signed in, one pool means the
    // stock lands in one place — otherwise a purchase would quietly recreate
    // the per-station duplicate the merge exists to remove.
    prismaMock.restaurant.findUnique.mockResolvedValue({ sharedStock: true })
    prismaMock.branch.findFirst.mockResolvedValue({ id: 'branch-main' })

    const response = await postInventoryPurchase(makeRequest(makeBody()))

    expect(response.status).toBe(201)
    expect(prismaMock.branch.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { restaurantId: 'rest-1', isMain: true },
    }))
    expect(txMock.inventoryPurchase.create.mock.calls[0][0].data.branchId).toBe('branch-main')
  })

  it('keeps the purchase at the recording station when stock is not shared', async () => {
    // Same entry, shared stock off: it must stay where it was typed rather than
    // being pulled to the main station.
    prismaMock.branch.findFirst.mockResolvedValue({ id: 'branch-bar' })

    const response = await postInventoryPurchase(makeRequest(makeBody({ branchId: 'branch-bar' })))

    expect(response.status).toBe(201)
    expect(txMock.inventoryPurchase.create.mock.calls[0][0].data.branchId).toBe('branch-bar')
  })

  it('rejects a malformed client id', async () => {
    const response = await postInventoryPurchase(makeRequest(makeBody({ id: 'x!' })))

    expect(response.status).toBe(400)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})

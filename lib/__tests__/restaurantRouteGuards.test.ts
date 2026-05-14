import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const getServerSessionMock = vi.hoisted(() => vi.fn())
const getRestaurantContextForUserMock = vi.hoisted(() => vi.fn())
const getRestaurantInventoryIntegrityMock = vi.hoisted(() => vi.fn())
const buildOwnerSyncSnapshotMock = vi.hoisted(() => vi.fn())
const prismaMock = vi.hoisted(() => ({
  restaurant: {
    findFirst: vi.fn(),
  },
  dishSale: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  shift: {
    findMany: vi.fn(),
  },
  wasteLog: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  transaction: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
  },
  inventoryItem: {
    findMany: vi.fn(),
  },
  inventoryPurchase: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  dishSaleIngredient: {
    findMany: vi.fn(),
  },
  pendingOrder: {
    count: vi.fn(),
    findFirst: vi.fn(),
  },
  restaurantOrder: {
    count: vi.fn(),
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
  getRestaurantContextForUser: getRestaurantContextForUserMock,
}))

vi.mock('@/lib/inventoryIntegrity', () => ({
  getRestaurantInventoryIntegrity: getRestaurantInventoryIntegrityMock,
}))

vi.mock('@/lib/ownerSync', () => ({
  buildOwnerSyncSnapshot: buildOwnerSyncSnapshotMock,
}))

vi.mock('@/lib/prisma', () => ({
  prisma: prismaMock,
}))

import { GET as getSyncExportRoute } from '@/app/api/restaurant/sync/export/route'
import { GET as getInventoryIntegrityRoute } from '@/app/api/restaurant/inventory-integrity/route'
import { GET as getStartupLogRoute } from '@/app/api/restaurant/startup-log/route'
import { GET as getDebugRoute } from '@/app/api/restaurant/debug/route'

function setSession(role: string | null) {
  getServerSessionMock.mockResolvedValue(role ? { user: { id: 'user-1', role } } : null)
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.MAGNIFY_STARTUP_LOG_PATH
  process.env.DATABASE_URL = 'file:C:/Users/HP/Documents/restaurant-app/prisma/dev.db'
})

describe('owner-enabled restaurant routes', () => {
  it('keeps sync export forbidden for non-owner roles', async () => {
    setSession('waiter')

    const response = await getSyncExportRoute()

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'Only the restaurant manager or owner can export sync data.',
    })
  })

  it('allows owners to export sync data', async () => {
    setSession('owner')
    getRestaurantContextForUserMock.mockResolvedValue({
      restaurantId: 'rest-1',
      billingUserId: 'bill-1',
      branchId: 'branch-1',
    })
    prismaMock.restaurant.findFirst.mockResolvedValue({ id: 'rest-1', name: 'Demo Restaurant' })
    prismaMock.dishSale.findMany.mockResolvedValue([])
    prismaMock.shift.findMany.mockResolvedValue([])
    prismaMock.wasteLog.findMany.mockResolvedValue([])
    prismaMock.transaction.findMany.mockResolvedValue([])
    prismaMock.inventoryItem.findMany.mockResolvedValue([])
    prismaMock.inventoryPurchase.findMany.mockResolvedValue([])
    prismaMock.dishSaleIngredient.findMany.mockResolvedValue([])
    prismaMock.pendingOrder.count.mockResolvedValue(0)
    prismaMock.dishSale.findFirst.mockResolvedValue(null)
    prismaMock.transaction.findFirst.mockResolvedValue(null)
    prismaMock.pendingOrder.findFirst.mockResolvedValue(null)
    prismaMock.inventoryPurchase.findFirst.mockResolvedValue(null)
    prismaMock.wasteLog.findFirst.mockResolvedValue(null)
    buildOwnerSyncSnapshotMock.mockReturnValue({ generated: true, restaurantId: 'rest-1' })

    const response = await getSyncExportRoute()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      snapshot: { generated: true, restaurantId: 'rest-1' },
    })
    expect(buildOwnerSyncSnapshotMock).toHaveBeenCalledOnce()
  })

  it('keeps inventory integrity forbidden for non-owner roles', async () => {
    setSession('cashier')

    const response = await getInventoryIntegrityRoute()

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' })
  })

  it('allows owners to read inventory integrity', async () => {
    setSession('owner')
    getRestaurantContextForUserMock.mockResolvedValue({
      restaurantId: 'rest-1',
      branchId: 'branch-1',
      billingUserId: 'bill-1',
    })
    getRestaurantInventoryIntegrityMock.mockResolvedValue({ ok: true, issueCount: 0 })

    const response = await getInventoryIntegrityRoute()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, issueCount: 0 })
  })

  it('keeps startup log forbidden for non-owner roles', async () => {
    setSession('waiter')

    const response = await getStartupLogRoute(new NextRequest('http://localhost/api/restaurant/startup-log'))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Admin or owner only' })
  })

  it('allows owners to open the startup log panel', async () => {
    setSession('owner')

    const response = await getStartupLogRoute(new NextRequest('http://localhost/api/restaurant/startup-log'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      available: false,
      path: null,
      updatedAt: null,
      sizeBytes: 0,
      truncated: false,
      content: '',
      message: 'Startup log is only available from the Magnify desktop app on this device.',
    })
  })

  it('keeps diagnostics forbidden for non-owner roles', async () => {
    setSession('cashier')

    const response = await getDebugRoute()

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Admin or owner only' })
  })

  it('allows owners to read diagnostics', async () => {
    setSession('owner')
    getRestaurantContextForUserMock.mockResolvedValue({
      restaurantId: 'rest-1',
      branchId: 'branch-1',
      billingUserId: 'bill-1',
    })
    prismaMock.restaurantOrder.count
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(5)
    prismaMock.transaction.count
      .mockResolvedValueOnce(40)
      .mockResolvedValueOnce(33)
    prismaMock.restaurantOrder.findFirst
      .mockResolvedValueOnce({
        id: 'order-1',
        orderNumber: '1001',
        createdAt: new Date('2026-05-01T10:00:00.000Z'),
        status: 'PENDING',
      })
      .mockResolvedValueOnce({
        id: 'order-2',
        orderNumber: '1002',
        paidAt: new Date('2026-05-01T11:00:00.000Z'),
        totalAmount: 25,
        paymentMethod: 'Cash',
      })
    prismaMock.transaction.findFirst.mockResolvedValue({
      id: 'txn-1',
      description: 'Sale',
      amount: 25,
      createdAt: new Date('2026-05-01T11:05:00.000Z'),
      paymentMethod: 'Cash',
      restaurantId: 'rest-1',
    })

    const response = await getDebugRoute()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      currentUserId: 'user-1',
      role: 'owner',
      restaurantId: 'rest-1',
      branchId: 'branch-1',
      billingUserId: 'bill-1',
      dbMode: 'local-sqlite',
      counts: {
        orderCount: 12,
        paidOrderCount: 7,
        pendingOrderCount: 5,
        accountingTransactionCount: 40,
        restaurantScopedTransactionCount: 33,
      },
    })
  })
})
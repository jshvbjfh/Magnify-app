import { beforeEach, describe, expect, it, vi } from 'vitest'

const getServerSessionMock = vi.hoisted(() => vi.fn())
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  dishSale: { findMany: vi.fn() },
  employeeShift: { findMany: vi.fn() },
  wasteLog: { findMany: vi.fn() },
  inventoryItem: { findMany: vi.fn() },
  restaurantOrder: { findMany: vi.fn() },
}))

vi.mock('next-auth', () => ({ getServerSession: getServerSessionMock }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/apiCache', () => ({ cached: (body: unknown) => Response.json(body) }))
vi.mock('@/lib/restaurantAccess', () => ({
  getRestaurantContextFromSession: () => ({ restaurantId: 'rest-1', branchId: 'branch-1' }),
}))

import { GET } from '@/app/api/restaurant/dashboard/route'

type PaidOrder = { totalAmount: number; guestCount: number | null }

async function callDashboard(paidOrders: PaidOrder[]) {
  prismaMock.restaurantOrder.findMany.mockResolvedValue(paidOrders)
  const response = await GET(new Request('http://localhost/api/restaurant/dashboard?period=today'))
  return response.json()
}

describe('GET /api/restaurant/dashboard — average per cover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getServerSessionMock.mockResolvedValue({ user: { id: 'user-1' } })
    prismaMock.user.findUnique.mockResolvedValue({ createdAt: new Date('2020-01-01') })
    prismaMock.dishSale.findMany.mockResolvedValue([])
    prismaMock.employeeShift.findMany.mockResolvedValue([])
    prismaMock.wasteLog.findMany.mockResolvedValue([])
    prismaMock.inventoryItem.findMany.mockResolvedValue([])
  })

  it('divides only the guest-counted revenue by the guests on those same orders', async () => {
    const body = await callDashboard([
      { totalAmount: 12000, guestCount: 3 },
      { totalAmount: 8000, guestCount: 2 },
    ])

    // 20,000 across 5 guests — both sides come from the same two orders.
    expect(body.apc).toBe(4000)
    expect(body.guestCount).toBe(5)
    expect(body.coveredOrders).toBe(2)
    expect(body.totalPaidOrders).toBe(2)
  })

  // The whole point of the feature: counting revenue from orders with no guest
  // count, against only the guests that were recorded, roughly doubles the
  // figure and still looks believable. Orders without a count stay out entirely.
  it('excludes orders with no guest count from the revenue as well as the guests', async () => {
    const body = await callDashboard([
      { totalAmount: 12000, guestCount: 3 },
      { totalAmount: 8000, guestCount: 2 },
      { totalAmount: 90000, guestCount: null },
    ])

    expect(body.apc).toBe(4000)
    expect(body.guestCount).toBe(5)
    expect(body.coveredOrders).toBe(2)
    // Coverage is still reported against every paid order, so the manager can
    // see how much of the day the average actually represents.
    expect(body.totalPaidOrders).toBe(3)
  })

  it('treats a zero or negative guest count as not recorded rather than as zero guests', async () => {
    const body = await callDashboard([
      { totalAmount: 10000, guestCount: 0 },
      { totalAmount: 5000, guestCount: -2 },
      { totalAmount: 6000, guestCount: 2 },
    ])

    expect(body.apc).toBe(3000)
    expect(body.guestCount).toBe(2)
    expect(body.coveredOrders).toBe(1)
  })

  it('reports zero without dividing when nothing has a guest count yet', async () => {
    const body = await callDashboard([
      { totalAmount: 12000, guestCount: null },
      { totalAmount: 8000, guestCount: null },
    ])

    expect(body.apc).toBe(0)
    expect(body.guestCount).toBe(0)
    expect(body.coveredOrders).toBe(0)
    expect(body.totalPaidOrders).toBe(2)
  })

  it('only asks the database for paid, undeleted orders in this branch', async () => {
    await callDashboard([])

    const where = prismaMock.restaurantOrder.findMany.mock.calls[0][0].where
    expect(where.restaurantId).toBe('rest-1')
    expect(where.branchId).toBe('branch-1')
    expect(where.status).toBe('PAID')
    expect(where.deletedAt).toBeNull()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const getServerSessionMock = vi.hoisted(() => vi.fn())
const getRestaurantContextForUserMock = vi.hoisted(() => vi.fn())
const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
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

vi.mock('@/lib/prisma', () => ({
  prisma: prismaMock,
}))

import { POST } from '@/app/api/restaurant/backup/route'

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/restaurant/backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getServerSessionMock.mockResolvedValue({ user: { id: 'user-1' } })
  getRestaurantContextForUserMock.mockResolvedValue({
    restaurantId: 'rest-1',
    branchId: null,
    billingUserId: 'bill-1',
  })
})

describe('backup restore route', () => {
  it('throws when branch-scoped restaurant data is restored without an active branch', async () => {
    prismaMock.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback({
      restaurant: {
        findUnique: vi.fn().mockResolvedValue({ id: 'rest-1' }),
      },
      branch: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    }))

    await expect(POST(makeRequest({
      version: 6,
      exportedAt: '2026-05-14T00:00:00.000Z',
      tables: [{ id: 'table-1' }],
    }))).rejects.toThrow('Active branch is required to restore branch-scoped restaurant data.')
  })

  it('allows non-branch-scoped backups when no active branch is available', async () => {
    prismaMock.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback({
      restaurant: {
        findUnique: vi.fn().mockResolvedValue({ id: 'rest-1' }),
      },
      branch: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    }))

    const response = await POST(makeRequest({
      version: 6,
      exportedAt: '2026-05-14T00:00:00.000Z',
      categories: [],
      accounts: [],
      goals: [],
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      skippedDishSales: 0,
    })
  })
})
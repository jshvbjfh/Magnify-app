import { beforeEach, describe, expect, it, vi } from 'vitest'

const compareMock = vi.hoisted(() => vi.fn())
const applyIncomingSyncChangesMock = vi.hoisted(() => vi.fn())
const recordRemoteChangeForPullMock = vi.hoisted(() => vi.fn())
const logSyncActivityMock = vi.hoisted(() => vi.fn())
const rateLimiterCheckMock = vi.hoisted(() => vi.fn())
const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  restaurant: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  staff: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}))

vi.mock('bcryptjs', () => ({
  compare: compareMock,
}))

vi.mock('@/lib/prisma', () => ({
  prisma: prismaMock,
}))

vi.mock('@/lib/syncEngine', () => ({
  applyIncomingSyncChanges: applyIncomingSyncChangesMock,
  recordRemoteChangeForPull: recordRemoteChangeForPullMock,
}))

vi.mock('@/lib/syncLogging', () => ({
  logSyncActivity: logSyncActivityMock,
}))

vi.mock('@/lib/syncOutbox', () => ({
  CLOUD_SYNC_TARGET: 'cloud',
  BRANCH_REQUIRED_ENTITY_TYPES: new Set(['dish', 'inventoryItem', 'employee']),
  GLOBAL_SYNC_SCOPE_ID: 'global',
  isRestaurantWideSyncEntity: (entityType: string) => ['restaurant', 'branch', 'restaurantBranch', 'pricingPlan'].includes(entityType),
  latestSyncChangeTimestamp: vi.fn(),
  latestSyncMutationId: vi.fn(),
  mapSyncOutboxRows: vi.fn().mockReturnValue([]),
}))

vi.mock('@/lib/rateLimit', () => ({
  createRateLimiter: () => ({
    check: rateLimiterCheckMock,
  }),
  getRateLimitKey: () => 'sync:test',
}))

vi.mock('@/lib/restaurantAccess', () => ({
  ensureMainBranchForRestaurant: vi.fn().mockResolvedValue({ id: 'branch-1' }),
}))

import { POST } from '@/app/api/sync/route'

describe('POST /api/sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OWNER_SYNC_SHARED_SECRET = 'secret-1'
    rateLimiterCheckMock.mockReturnValue({ allowed: true, resetAt: Date.now() + 60_000 })
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'manager-user-1',
      email: 'manager@example.com',
      password: 'hashed-password',
      role: 'admin',
      isActive: true,
    })
    prismaMock.restaurant.findUnique.mockResolvedValue(null)
    prismaMock.restaurant.findFirst.mockResolvedValue({
      id: 'rest-1',
      name: 'Managed Restaurant',
      ownerId: 'owner-1',
      joinCode: 'JOIN99',
      syncRestaurantId: null,
    })
  })

  it('resolves restaurant identity for manager-linked accounts when identifiers are missing', async () => {
    const request = new Request('http://localhost/api/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-email': 'manager@example.com',
        'x-sync-secret': 'secret-1',
      },
      body: JSON.stringify({ resolveRestaurantOnly: true }),
    })

    const response = await POST(request)

    expect(prismaMock.restaurant.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [{ ownerId: 'manager-user-1' }, { managerId: 'manager-user-1' }],
        deletedAt: null,
      },
      select: { id: true, name: true, ownerId: true, joinCode: true, syncRestaurantId: true },
      orderBy: { createdAt: 'asc' },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      restaurant: {
        id: 'rest-1',
        name: 'Managed Restaurant',
        joinCode: 'JOIN99',
        syncRestaurantId: null,
      },
    })
  })
})
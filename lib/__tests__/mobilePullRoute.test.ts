import { beforeEach, describe, expect, it, vi } from 'vitest'

const jwtVerifyMock = vi.hoisted(() => vi.fn())
const resolveActiveStaffAccessMock = vi.hoisted(() => vi.fn())
const prismaMock = vi.hoisted(() => ({
  dish: {
    findMany: vi.fn(),
  },
  restaurantTable: {
    findMany: vi.fn(),
  },
  restaurant: {
    findUnique: vi.fn(),
  },
  staff: {
    findMany: vi.fn(),
  },
  branch: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  restaurantOrder: {
    findMany: vi.fn(),
  },
  mepListItem: {
    findMany: vi.fn(),
  },
  prepLog: {
    findMany: vi.fn(),
  },
  inventoryItem: {
    findMany: vi.fn(),
  },
  shift: {
    findFirst: vi.fn(),
  },
}))

vi.mock('jose', () => ({
  jwtVerify: jwtVerifyMock,
}))

vi.mock('@/lib/mobileStaffAccess', () => ({
  resolveActiveStaffAccess: resolveActiveStaffAccessMock,
}))

vi.mock('@/lib/prisma', () => ({
  prisma: prismaMock,
}))

import { GET } from '@/app/api/mobile/pull/route'

describe('GET /api/mobile/pull', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'staff-1',
        restaurantId: 'jwt-rest',
        branchId: 'jwt-branch',
        role: 'waiter',
      },
    })
    resolveActiveStaffAccessMock.mockResolvedValue({
      restaurantId: 'bound-rest',
      branchId: 'bound-branch',
    })
    prismaMock.dish.findMany.mockResolvedValue([
      {
        id: 'dish-1',
        name: 'Scoped Dish',
        sellingPrice: 12.5,
        category: null,
        isActive: true,
        branchId: 'bound-branch',
        restaurantId: 'bound-rest',
      },
    ])
    prismaMock.restaurantTable.findMany.mockResolvedValue([
      {
        id: 'table-1',
        name: 'T44',
        seats: 4,
        status: 'available',
        branchId: 'bound-branch',
        restaurantId: 'bound-rest',
      },
    ])
    prismaMock.restaurant.findUnique.mockResolvedValue({ id: 'bound-rest', name: 'Erick Pizzeria' })
    prismaMock.staff.findMany.mockResolvedValue([])
    prismaMock.branch.findMany.mockResolvedValue([
      { id: 'bound-branch', name: 'Main', code: 'MAIN', isMain: true },
    ])
    prismaMock.restaurantOrder.findMany.mockResolvedValue([])
    prismaMock.mepListItem.findMany.mockResolvedValue([])
    prismaMock.prepLog.findMany.mockResolvedValue([])
    prismaMock.inventoryItem.findMany.mockResolvedValue([])
    prismaMock.shift.findFirst.mockResolvedValue(null)
  })

  it('uses the current DB staff binding instead of stale JWT restaurant claims', async () => {
    const response = await GET(new Request('http://localhost/api/mobile/pull', {
      headers: { authorization: 'Bearer token-1' },
    }))

    expect(response.status).toBe(200)
    // Dishes and tables are restaurant-wide by design, but the restaurant must
    // come from the staff's CURRENT DB binding, never the stale JWT claims.
    expect(prismaMock.dish.findMany).toHaveBeenCalledWith({
      where: {
        restaurantId: 'bound-rest',
        isActive: true,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        sellingPrice: true,
        category: true,
        menuType: true,
        isActive: true,
        branchId: true,
        restaurantId: true,
        preparedPortions: true,
      },
      orderBy: { name: 'asc' },
    })
    expect(prismaMock.restaurantTable.findMany).toHaveBeenCalledWith({
      where: {
        restaurantId: 'bound-rest',
      },
      select: {
        id: true,
        name: true,
        seats: true,
        status: true,
        branchId: true,
        restaurantId: true,
      },
      orderBy: { name: 'asc' },
    })

    await expect(response.json()).resolves.toMatchObject({
      restaurant: {
        id: 'bound-rest',
        name: 'Erick Pizzeria',
      },
      dishes: [
        {
          id: 'dish-1',
          name: 'Scoped Dish',
          restaurant_id: 'bound-rest',
          branch_id: 'bound-branch',
        },
      ],
      tables: [
        {
          id: 'table-1',
          name: 'T44',
          restaurant_id: 'bound-rest',
          branch_id: 'bound-branch',
        },
      ],
    })
  })
})
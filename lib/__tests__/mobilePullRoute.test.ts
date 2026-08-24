import { beforeEach, describe, expect, it, vi } from 'vitest'

const jwtVerifyMock = vi.hoisted(() => vi.fn())
const resolveActiveStaffAccessMock = vi.hoisted(() => vi.fn())
const prismaMock = vi.hoisted(() => ({
  dish: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
  },
  restaurantTable: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
  },
  restaurant: {
    findUnique: vi.fn(),
  },
  staff: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
  },
  branch: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    aggregate: vi.fn(),
  },
  restaurantOrder: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
  },
  orderItem: {
    aggregate: vi.fn(),
  },
  mepListItem: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
  },
  prepLog: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
  },
  inventoryItem: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
  },
  shift: {
    findFirst: vi.fn(),
    aggregate: vi.fn(),
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

    // The change-token aggregates. A stable set here means every existing test
    // gets the same token, so they exercise the full-payload path exactly as
    // before unless they deliberately send ?since=.
    prismaMock.restaurantOrder.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _max: { updatedAt: new Date('2026-08-24T08:00:00.000Z') },
    })
    prismaMock.orderItem.aggregate.mockResolvedValue({
      _count: { _all: 5 },
      _max: { updatedAt: new Date('2026-08-24T08:00:00.000Z') },
    })
    prismaMock.shift.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _max: { updatedAt: new Date('2026-08-24T07:00:00.000Z') },
    })

    // Catalog-token aggregates. Only computed on a pull that asks for the menu.
    const catalogStat = {
      _count: { _all: 3 },
      _max: { updatedAt: new Date('2026-08-20T09:00:00.000Z') },
    }
    prismaMock.dish.aggregate.mockResolvedValue(catalogStat)
    prismaMock.restaurantTable.aggregate.mockResolvedValue(catalogStat)
    prismaMock.staff.aggregate.mockResolvedValue(catalogStat)
    prismaMock.branch.aggregate.mockResolvedValue(catalogStat)
    prismaMock.mepListItem.aggregate.mockResolvedValue(catalogStat)
    prismaMock.prepLog.aggregate.mockResolvedValue(catalogStat)
    prismaMock.inventoryItem.aggregate.mockResolvedValue(catalogStat)
  })

  // Every device polled this endpoint every 10 seconds and got twelve queries
  // back, almost all of it catalog data nobody had touched. ?catalog=0 asks for
  // the order half alone; these pin down that it genuinely stops querying, and
  // that it still returns the orders it was asked for.
  it('skips the catalog queries when the client asks for orders only', async () => {
    const response = await GET(new Request('http://localhost/api/mobile/pull?catalog=0', {
      headers: { authorization: 'Bearer token-1' },
    }))

    expect(response.status).toBe(200)
    expect(prismaMock.dish.findMany).not.toHaveBeenCalled()
    expect(prismaMock.restaurantTable.findMany).not.toHaveBeenCalled()
    expect(prismaMock.staff.findMany).not.toHaveBeenCalled()
    expect(prismaMock.branch.findMany).not.toHaveBeenCalled()
    expect(prismaMock.mepListItem.findMany).not.toHaveBeenCalled()
    expect(prismaMock.prepLog.findMany).not.toHaveBeenCalled()
    expect(prismaMock.inventoryItem.findMany).not.toHaveBeenCalled()

    // Orders and the open shift are the point of the poll and must still run.
    expect(prismaMock.restaurantOrder.findMany).toHaveBeenCalled()
    expect(prismaMock.shift.findFirst).toHaveBeenCalled()
  })

  it('flags a light pull so the client leaves its cached menu alone', async () => {
    const light = await GET(new Request('http://localhost/api/mobile/pull?catalog=0', {
      headers: { authorization: 'Bearer token-1' },
    }))
    // Without this the empty dishes array is indistinguishable from a station
    // whose menu really is empty, and the waiter is told their menu is gone.
    await expect(light.json()).resolves.toMatchObject({ catalogIncluded: false })
  })

  it('still sends the catalog when not asked to skip it', async () => {
    const full = await GET(new Request('http://localhost/api/mobile/pull', {
      headers: { authorization: 'Bearer token-1' },
    }))
    expect(prismaMock.dish.findMany).toHaveBeenCalled()
    await expect(full.json()).resolves.toMatchObject({ catalogIncluded: true })
  })

  // A poll used to cost the same whether anything had happened or not: four
  // queries re-sending every order and line, every ten seconds, per device.
  // These pin down that an unchanged poll now reads nothing at all, and — more
  // important — that the token actually moves for every kind of change, because
  // a token that misses one strands a waiter on a stale floor.
  const tokenFor = async (url: string) => {
    const response = await GET(new Request(url, { headers: { authorization: 'Bearer token-1' } }))
    return ((await response.json()) as { changeToken: string }).changeToken
  }

  it('answers an unchanged poll without reading a single order', async () => {
    const changeToken = await tokenFor('http://localhost/api/mobile/pull?catalog=0')
    expect(changeToken).toBeTruthy()

    prismaMock.restaurantOrder.findMany.mockClear()
    prismaMock.shift.findFirst.mockClear()

    const second = await GET(new Request(
      `http://localhost/api/mobile/pull?catalog=0&since=${encodeURIComponent(changeToken)}`,
      { headers: { authorization: 'Bearer token-1' } },
    ))

    await expect(second.json()).resolves.toMatchObject({ unchanged: true, changeToken })
    // The entire saving: no order rows and no shift row were fetched.
    expect(prismaMock.restaurantOrder.findMany).not.toHaveBeenCalled()
    expect(prismaMock.shift.findFirst).not.toHaveBeenCalled()
  })

  it('sends the orders again once the token has moved on', async () => {
    const response = await GET(new Request(
      'http://localhost/api/mobile/pull?catalog=0&since=a-stale-token',
      { headers: { authorization: 'Bearer token-1' } },
    ))
    const body = await response.json() as Record<string, unknown>
    expect(body.unchanged).toBeUndefined()
    expect(prismaMock.restaurantOrder.findMany).toHaveBeenCalled()
  })

  it('moves the token when only a LINE changed and the order row did not', async () => {
    // Adding a dish to an open bill writes an OrderItem and leaves
    // restaurant_orders.updatedAt untouched. Watching orders alone would miss
    // it and the new line would never reach the kitchen.
    const before = await tokenFor('http://localhost/api/mobile/pull?catalog=0')
    prismaMock.orderItem.aggregate.mockResolvedValue({
      _count: { _all: 6 },
      _max: { updatedAt: new Date('2026-08-24T08:05:00.000Z') },
    })
    const after = await tokenFor('http://localhost/api/mobile/pull?catalog=0')
    expect(after).not.toBe(before)
  })

  it('moves the token when an order is deleted and no timestamp changes', async () => {
    // A delete lowers the count while every surviving row keeps its timestamp,
    // so max(updatedAt) alone would strand the removed order on the floor.
    const before = await tokenFor('http://localhost/api/mobile/pull?catalog=0')
    prismaMock.restaurantOrder.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _max: { updatedAt: new Date('2026-08-24T08:00:00.000Z') },
    })
    const after = await tokenFor('http://localhost/api/mobile/pull?catalog=0')
    expect(after).not.toBe(before)
  })

  it('never short-circuits a pull that asked for the catalog', async () => {
    const changeToken = await tokenFor('http://localhost/api/mobile/pull?catalog=0')
    prismaMock.dish.findMany.mockClear()

    const response = await GET(new Request(
      `http://localhost/api/mobile/pull?since=${encodeURIComponent(changeToken)}`,
      { headers: { authorization: 'Bearer token-1' } },
    ))

    const body = await response.json() as Record<string, unknown>
    expect(body.unchanged).toBeUndefined()
    expect(prismaMock.dish.findMany).toHaveBeenCalled()
  })

  // The catalog half is the larger payload: 231 dishes plus tables, staff,
  // stations, MEP and preps, shipped every 60 seconds for a menu that changes a
  // few times a week.
  it('skips the whole catalog when it has not changed, keeping the interval', async () => {
    const first = await GET(new Request('http://localhost/api/mobile/pull', {
      headers: { authorization: 'Bearer token-1' },
    }))
    const { catalogToken } = (await first.json()) as { catalogToken: string }
    expect(catalogToken).toBeTruthy()

    prismaMock.dish.findMany.mockClear()
    prismaMock.restaurantTable.findMany.mockClear()
    prismaMock.staff.findMany.mockClear()

    const second = await GET(new Request(
      `http://localhost/api/mobile/pull?catalogSince=${encodeURIComponent(catalogToken)}`,
      { headers: { authorization: 'Bearer token-1' } },
    ))

    await expect(second.json()).resolves.toMatchObject({
      catalogUnchanged: true,
      catalogIncluded: false,
      catalogToken,
    })
    // Not one catalog row was read.
    expect(prismaMock.dish.findMany).not.toHaveBeenCalled()
    expect(prismaMock.restaurantTable.findMany).not.toHaveBeenCalled()
    expect(prismaMock.staff.findMany).not.toHaveBeenCalled()
  })

  it('sends the catalog again as soon as one dish moves', async () => {
    const first = await GET(new Request('http://localhost/api/mobile/pull', {
      headers: { authorization: 'Bearer token-1' },
    }))
    const { catalogToken } = (await first.json()) as { catalogToken: string }

    // A dish marked out, or a price edit — the menu must reach the floor.
    prismaMock.dish.aggregate.mockResolvedValue({
      _count: { _all: 4 },
      _max: { updatedAt: new Date('2026-08-24T09:00:00.000Z') },
    })

    const second = await GET(new Request(
      `http://localhost/api/mobile/pull?catalogSince=${encodeURIComponent(catalogToken)}`,
      { headers: { authorization: 'Bearer token-1' } },
    ))

    await expect(second.json()).resolves.toMatchObject({ catalogIncluded: true })
    expect(prismaMock.dish.findMany).toHaveBeenCalled()
  })

  it('moves the catalog token when only the prep list changed', async () => {
    // MEP and stock ride in the catalog half and move during service. A menu
    // that has not changed must not mask a prep list that has.
    const before = await GET(new Request('http://localhost/api/mobile/pull', {
      headers: { authorization: 'Bearer token-1' },
    }))
    const a = (await before.json()) as { catalogToken: string }

    prismaMock.mepListItem.aggregate.mockResolvedValue({
      _count: { _all: 9 },
      _max: { updatedAt: new Date('2026-08-24T09:30:00.000Z') },
    })

    const after = await GET(new Request('http://localhost/api/mobile/pull', {
      headers: { authorization: 'Bearer token-1' },
    }))
    const b = (await after.json()) as { catalogToken: string }
    expect(b.catalogToken).not.toBe(a.catalogToken)
  })

  it('answers a fully unchanged poll with both halves skipped', async () => {
    const first = await GET(new Request('http://localhost/api/mobile/pull', {
      headers: { authorization: 'Bearer token-1' },
    }))
    const { changeToken, catalogToken } = (await first.json()) as {
      changeToken: string; catalogToken: string
    }

    prismaMock.dish.findMany.mockClear()
    prismaMock.restaurantOrder.findMany.mockClear()

    const second = await GET(new Request(
      `http://localhost/api/mobile/pull?since=${encodeURIComponent(changeToken)}&catalogSince=${encodeURIComponent(catalogToken)}`,
      { headers: { authorization: 'Bearer token-1' } },
    ))

    await expect(second.json()).resolves.toMatchObject({ unchanged: true })
    expect(prismaMock.dish.findMany).not.toHaveBeenCalled()
    expect(prismaMock.restaurantOrder.findMany).not.toHaveBeenCalled()
  })

  it('does not cry wolf about an empty menu on a light pull', async () => {
    // A light pull returns no dishes by design. Warning on it fired thousands
    // of times a day and read as if a station had lost its menu.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await GET(new Request('http://localhost/api/mobile/pull?catalog=0', {
      headers: { authorization: 'Bearer token-1' },
    }))
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
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
import { beforeEach, describe, expect, it, vi } from 'vitest'

const jwtVerifyMock = vi.hoisted(() => vi.fn())
const resolveActiveStaffAccessMock = vi.hoisted(() => vi.fn())
const resolveCancellationApproverMock = vi.hoisted(() => vi.fn())
const enqueueOrderSyncMock = vi.hoisted(() => vi.fn())

const txMock = vi.hoisted(() => ({
  orderItem: { updateMany: vi.fn() },
  restaurantOrder: { update: vi.fn() },
}))

const prismaMock = vi.hoisted(() => ({
  restaurantOrder: {
    findFirst: vi.fn(),
  },
  $transaction: vi.fn(),
}))

vi.mock('jose', () => ({
  jwtVerify: jwtVerifyMock,
}))

vi.mock('@/lib/mobileStaffAccess', () => ({
  resolveActiveStaffAccess: resolveActiveStaffAccessMock,
}))

vi.mock('@/lib/cancelApproval', () => ({
  resolveCancellationApprover: resolveCancellationApproverMock,
}))

vi.mock('@/lib/restaurantOrders', () => ({
  enqueueOrderSync: enqueueOrderSyncMock,
}))

vi.mock('@/lib/prisma', () => ({
  prisma: prismaMock,
}))

import { POST } from '@/app/api/mobile/cancel-order/route'

function request(body: unknown) {
  return new Request('http://localhost/api/mobile/cancel-order', {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const VALID_BODY = {
  orderId: 'order-1',
  supervisorPin: '12345',
  cancelReason: 'Customer changed mind',
}

describe('POST /api/mobile/cancel-order', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'staff-1', restaurantId: 'rest-1', branchId: 'office-stock', role: 'waiter' },
    })

    // The terminal's staff account is bound to the main/office branch...
    resolveActiveStaffAccessMock.mockResolvedValue({
      staffId: 'staff-1',
      restaurantId: 'rest-1',
      branchId: 'office-stock',
    })

    // ...while the order itself was taken at a different station. This is the
    // normal case at any multi-station venue, and it used to 404.
    prismaMock.restaurantOrder.findFirst.mockResolvedValue({
      id: 'order-1',
      restaurantId: 'rest-1',
      branchId: 'breakfast-menu',
      status: 'PENDING',
    })

    prismaMock.$transaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock))
    resolveCancellationApproverMock.mockResolvedValue({ id: 'sup-1', name: 'Marie' })
    enqueueOrderSyncMock.mockResolvedValue(undefined)
  })

  it('cancels an order that lives on a different branch from the terminal', async () => {
    const res = await POST(request(VALID_BODY))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true, approvedBy: 'Marie' })

    // The lookup must be restaurant-scoped — never narrowed to the terminal's branch.
    const where = prismaMock.restaurantOrder.findFirst.mock.calls[0][0].where
    expect(where).toEqual({ id: 'order-1', restaurantId: 'rest-1' })
    expect(where).not.toHaveProperty('branchId')

    expect(txMock.restaurantOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'order-1' } }),
    )
  })

  it('records WHO approved the cancellation, not just the reason', async () => {
    // cancelReason says why a bill was voided; without the approver's name the
    // cancellation report can never answer the question anyone actually asks of
    // a night's voids — on whose authority. The name comes from the PIN that
    // was validated, never from the client.
    await POST(request(VALID_BODY))

    expect(txMock.restaurantOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1' },
        data: expect.objectContaining({ status: 'CANCELED', canceledByName: 'Marie' }),
      }),
    )
  })

  it('enqueues the sync change on the order\'s branch, not the terminal\'s', async () => {
    await POST(request(VALID_BODY))

    expect(enqueueOrderSyncMock).toHaveBeenCalledWith(
      prismaMock,
      'order-1',
      'rest-1',
      'breakfast-menu',
    )
  })

  it('refuses an order belonging to another restaurant', async () => {
    prismaMock.restaurantOrder.findFirst.mockResolvedValue(null)

    const res = await POST(request(VALID_BODY))

    expect(res.status).toBe(404)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a JWT whose restaurant no longer matches the staff binding', async () => {
    resolveActiveStaffAccessMock.mockResolvedValue({
      staffId: 'staff-1',
      restaurantId: 'other-rest',
      branchId: 'office-stock',
    })

    const res = await POST(request(VALID_BODY))

    expect(res.status).toBe(401)
    expect(prismaMock.restaurantOrder.findFirst).not.toHaveBeenCalled()
  })

  it('rejects a deactivated staff account', async () => {
    resolveActiveStaffAccessMock.mockResolvedValue(null)

    const res = await POST(request(VALID_BODY))

    expect(res.status).toBe(401)
    expect(prismaMock.restaurantOrder.findFirst).not.toHaveBeenCalled()
  })

  it('rejects an invalid supervisor PIN without touching the order', async () => {
    resolveCancellationApproverMock.mockResolvedValue(null)

    const res = await POST(request(VALID_BODY))

    expect(res.status).toBe(403)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('refuses to cancel a paid order', async () => {
    prismaMock.restaurantOrder.findFirst.mockResolvedValue({
      id: 'order-1',
      restaurantId: 'rest-1',
      branchId: 'breakfast-menu',
      status: 'PAID',
    })

    const res = await POST(request(VALID_BODY))

    expect(res.status).toBe(409)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('is idempotent when the order is already canceled', async () => {
    prismaMock.restaurantOrder.findFirst.mockResolvedValue({
      id: 'order-1',
      restaurantId: 'rest-1',
      branchId: 'breakfast-menu',
      status: 'CANCELED',
    })

    const res = await POST(request(VALID_BODY))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true, alreadyCanceled: true })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})

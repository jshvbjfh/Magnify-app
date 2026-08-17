// Order, shift and MEP sync round-trips against a real SQLite engine.
//
// These are the paths that move money and attribution: an order the server
// never receives is lost revenue, and an order marked synced when it wasn't is
// worse. Same node:sqlite substitution as db.android.test.ts — the code under
// test is the real shipped db.ts.

import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function createFakeConnection() {
  const db = new DatabaseSync(':memory:')
  const bind = (values: unknown[] = []) =>
    values.map((v) => (v === undefined ? null : v)) as never[]

  return {
    db,
    open: async () => {},
    execute: async (statements: string) => {
      db.exec(statements)
      return { changes: { changes: 0 } }
    },
    query: async (statement: string, values: unknown[] = []) => ({
      values: db.prepare(statement).all(...bind(values)),
    }),
    run: async (statement: string, values: unknown[] = []) => {
      const r = db.prepare(statement).run(...bind(values))
      return { changes: { changes: r.changes, lastId: Number(r.lastInsertRowid) } }
    },
    executeSet: async (set: Array<{ statement: string; values: unknown[] }>) => {
      db.exec('BEGIN')
      try {
        let changes = 0
        for (const s of set) changes += db.prepare(s.statement).run(...bind(s.values)).changes
        db.exec('COMMIT')
        return { changes: { changes } }
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
}

let fake: ReturnType<typeof createFakeConnection>

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteDBConnection: class {},
  SQLiteConnection: class {
    async checkConnectionsConsistency() { return { result: false } }
    async isConnection() { return { result: false } }
    async createConnection() { return fake }
    async retrieveConnection() { return fake }
  },
}))

async function freshDb() {
  vi.resetModules()
  fake = createFakeConnection()
  const mod = await import('../db')
  await mod.initDB()
  return mod
}

const T0 = '2026-08-13T10:00:00.000Z'
const T1 = '2026-08-13T11:00:00.000Z'
const T2 = '2026-08-13T12:00:00.000Z'

const makeOrder = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  restaurant_id: 'rest-1',
  branch_id: 'branch-1',
  table_id: 'tbl-1',
  table_name: 'T1',
  order_number: `WA-${id}`,
  status: 'PENDING',
  payment_method: null,
  subtotal_amount: 5000,
  vat_amount: 0,
  total_amount: 5000,
  created_by_name: 'Alice',
  served_at: null,
  paid_at: null,
  canceled_at: null,
  cancel_reason: null,
  shift_id: 'shift-1',
  business_date: '2026-08-13',
  synced: 0,
  sync_error: null,
  created_at: T0,
  updated_at: T0,
  ...over,
}) as never

const makeItem = (id: string, orderId: string) => ({
  id,
  order_id: orderId,
  dish_id: 'dish-1',
  dish_name: 'Pizza',
  dish_price: 5000,
  qty: 1,
  status: 'ACTIVE',
  notes: null,
  branch_id: 'branch-1',
  created_at: T0,
  updated_at: T0,
}) as never

const makeShift = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  restaurant_id: 'rest-1',
  business_date: '2026-08-13',
  status: 'OPEN',
  opened_at: T0,
  opened_by_name: 'Alice',
  opened_by_staff_id: 'staff-1',
  closed_at: null,
  closed_by_name: null,
  closed_by_staff_id: null,
  source_device_id: 'device-1',
  synced: 0,
  created_at: T0,
  updated_at: T0,
  ...over,
}) as never

describe('order push round-trip', () => {
  beforeEach(() => vi.clearAllMocks())

  it('queues a new order with its items and clears it once acknowledged', async () => {
    const { createOrder, getUnsyncedOrders, markOrdersSynced } = await freshDb()

    await createOrder(makeOrder('o1'), [makeItem('i1', 'o1'), makeItem('i2', 'o1')])

    const pending = await getUnsyncedOrders()
    expect(pending.orders.map((o) => o.id)).toEqual(['o1'])
    expect(pending.items).toHaveLength(2)
    // The shift stamp has to survive to the server or the order falls outside
    // every shift-scoped report.
    expect(pending.orders[0].shift_id).toBe('shift-1')
    expect(pending.orders[0].business_date).toBe('2026-08-13')

    await markOrdersSynced(pending.orders)
    expect((await getUnsyncedOrders()).orders).toHaveLength(0)
  })

  it('does not mark an order synced if the waiter edited it mid-flight', async () => {
    const { createOrder, getUnsyncedOrders, markOrdersSynced, updateOrder } = await freshDb()

    await createOrder(makeOrder('o1'), [makeItem('i1', 'o1')])
    const inFlight = (await getUnsyncedOrders()).orders

    // Waiter adds an item while the push is on the wire — updated_at moves.
    await updateOrder('o1', { total_amount: 9000 })

    // Acknowledging the stale snapshot must not clear the newer local state,
    // or the edit is silently dropped and never reaches the server.
    await markOrdersSynced(inFlight)
    expect((await getUnsyncedOrders()).orders.map((o) => o.id)).toEqual(['o1'])
  })

  it('re-queues an order whenever it is edited locally', async () => {
    const { createOrder, getUnsyncedOrders, markOrdersSynced, updateOrder } = await freshDb()

    await createOrder(makeOrder('o1'), [makeItem('i1', 'o1')])
    await markOrdersSynced((await getUnsyncedOrders()).orders)
    expect((await getUnsyncedOrders()).orders).toHaveLength(0)

    await updateOrder('o1', { status: 'PAID', payment_method: 'Cash' })
    expect((await getUnsyncedOrders()).orders.map((o) => o.id)).toEqual(['o1'])
  })
})

describe('pull reconciliation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('applies a newer server status without re-queueing the order', async () => {
    const { createOrder, markOrdersSynced, getUnsyncedOrders, reconcileOrderStatuses, getOrderById } = await freshDb()

    await createOrder(makeOrder('o1'), [makeItem('i1', 'o1')])
    await markOrdersSynced((await getUnsyncedOrders()).orders)

    await reconcileOrderStatuses([{
      id: 'o1', status: 'PAID', payment_method: 'Cash',
      paid_at: T1, canceled_at: null, cancel_reason: null, updated_at: T1,
    }])

    expect((await getOrderById('o1'))?.status).toBe('PAID')
    expect((await getUnsyncedOrders()).orders).toHaveLength(0)
  })

  it('ignores a stale server status older than the local edit', async () => {
    const { createOrder, reconcileOrderStatuses, getOrderById } = await freshDb()

    await createOrder(makeOrder('o1', { updated_at: T2 }), [makeItem('i1', 'o1')])
    await reconcileOrderStatuses([{
      id: 'o1', status: 'CANCELED', payment_method: null,
      paid_at: null, canceled_at: T1, cancel_reason: 'stale', updated_at: T1,
    }])

    expect((await getOrderById('o1'))?.status).toBe('PENDING')
  })

  it('inserts guest QR orders without clobbering a local copy', async () => {
    const { upsertIncomingOrders, getOrders, updateOrder, getOrderById } = await freshDb()

    const incoming = {
      id: 'qr-1', restaurant_id: 'rest-1', branch_id: 'branch-1', table_id: 'tbl-1',
      table_name: 'T1', order_number: 'QR-1', status: 'UNCONFIRMED', payment_method: null,
      subtotal_amount: 3000, vat_amount: 0, total_amount: 3000, created_by_name: 'Guest QR Order',
      paid_at: null, canceled_at: null, cancel_reason: null,
      created_at: T0, updated_at: T0,
      items: [{ id: 'qi-1', order_id: 'qr-1', dish_id: 'dish-9', dish_name: 'Coke', dish_price: 3000, qty: 1, status: 'ACTIVE', notes: null, created_at: T0, updated_at: T0 }],
    } as never

    await upsertIncomingOrders([incoming])
    expect((await getOrders()).map((o) => o.id)).toContain('qr-1')

    // Waiter confirms it locally, then the same order arrives on the next pull.
    await updateOrder('qr-1', { status: 'PENDING' })
    await upsertIncomingOrders([incoming])
    expect((await getOrderById('qr-1'))?.status).toBe('PENDING')
  })
})

describe('deleteServerRemovedOrders', () => {
  beforeEach(() => vi.clearAllMocks())

  it('purges acknowledged orders the server no longer has', async () => {
    const { createOrder, markOrdersSynced, getUnsyncedOrders, deleteServerRemovedOrders, getOrders, getOrderItems } = await freshDb()

    await createOrder(makeOrder('o1'), [makeItem('i1', 'o1')])
    await createOrder(makeOrder('o2'), [makeItem('i2', 'o2')])
    await markOrdersSynced((await getUnsyncedOrders()).orders)

    const removed = await deleteServerRemovedOrders('rest-1', ['o1'])

    expect(removed).toBe(1)
    expect((await getOrders()).map((o) => o.id)).toEqual(['o1'])
    // Items must go with the order, not linger as orphans.
    expect(await getOrderItems('o2')).toHaveLength(0)
  })

  it('never destroys an order that has not been pushed yet', async () => {
    const { createOrder, deleteServerRemovedOrders, getOrders } = await freshDb()

    // Taken offline — the server has never seen it and its list cannot vouch for it.
    await createOrder(makeOrder('o-offline'), [makeItem('i1', 'o-offline')])

    expect(await deleteServerRemovedOrders('rest-1', [])).toBe(0)
    expect((await getOrders()).map((o) => o.id)).toEqual(['o-offline'])
  })
})

describe('shift sync', () => {
  beforeEach(() => vi.clearAllMocks())

  it('queues a locally opened shift and clears it on acknowledgement', async () => {
    const { upsertShiftFromServer, getUnsyncedShifts, markShiftsSynced, getOpenShift } = await freshDb()

    // A shift opened on this device starts unsynced.
    fake.db.prepare(`INSERT INTO shifts (id, restaurant_id, business_date, status, opened_at, opened_by_name, opened_by_staff_id, closed_at, closed_by_name, closed_by_staff_id, source_device_id, synced, created_at, updated_at) VALUES ('shift-1','rest-1','2026-08-13','OPEN',?, 'Alice','staff-1',NULL,NULL,NULL,'device-1',0,?,?)`).run(T0, T0, T0)

    expect((await getUnsyncedShifts()).map((s) => s.id)).toEqual(['shift-1'])

    // A pull arriving before the push must not overwrite our unsynced shift.
    await upsertShiftFromServer(makeShift('shift-1', { status: 'CLOSED', synced: 1 }))
    expect((await getOpenShift('rest-1'))?.id).toBe('shift-1')

    await markShiftsSynced(['shift-1'])
    expect(await getUnsyncedShifts()).toHaveLength(0)
  })

  it('closes a synced open shift when the server reports none', async () => {
    const { upsertShiftFromServer, reconcileNoOpenShift, getOpenShift } = await freshDb()

    await upsertShiftFromServer(makeShift('shift-1', { synced: 1 }))
    expect((await getOpenShift('rest-1'))?.id).toBe('shift-1')

    // Another terminal ended the shift.
    await reconcileNoOpenShift('rest-1')
    expect(await getOpenShift('rest-1')).toBeNull()
  })
})

describe('MEP', () => {
  beforeEach(() => vi.clearAllMocks())

  it('replaces a station list and reports sold-out dishes', async () => {
    const { replaceMepItems, adjustMepRemaining, getMepOutDishIds } = await freshDb()

    await replaceMepItems([
      { id: 'm1', restaurant_id: 'rest-1', branch_id: 'branch-1', target_type: 'dish', target_id: 'dish-1', name: 'Pizza', unit: 'pcs', remaining: 2, updated_at: T0 },
      { id: 'm2', restaurant_id: 'rest-1', branch_id: 'branch-1', target_type: 'dish', target_id: 'dish-2', name: 'Pasta', unit: 'pcs', remaining: 0, updated_at: T0 },
    ] as never, 'branch-1')

    expect(await getMepOutDishIds('branch-1')).toEqual(['dish-2'])

    // Selling the last two portions takes dish-1 out too, and never below zero.
    await adjustMepRemaining('dish', 'dish-1', -5)
    expect((await getMepOutDishIds('branch-1')).sort()).toEqual(['dish-1', 'dish-2'])
  })

  it('keeps another station\'s MEP list intact', async () => {
    const { replaceMepItems, getMepOutDishIds } = await freshDb()

    await replaceMepItems([
      { id: 'm9', restaurant_id: 'rest-1', branch_id: 'branch-2', target_type: 'dish', target_id: 'dish-9', name: 'Soup', unit: 'pcs', remaining: 0, updated_at: T0 },
    ] as never, 'branch-2')
    await replaceMepItems([
      { id: 'm1', restaurant_id: 'rest-1', branch_id: 'branch-1', target_type: 'dish', target_id: 'dish-1', name: 'Pizza', unit: 'pcs', remaining: 0, updated_at: T0 },
    ] as never, 'branch-1')

    expect(await getMepOutDishIds('branch-2')).toEqual(['dish-9'])
    expect(await getMepOutDishIds('branch-1')).toEqual(['dish-1'])
  })
})

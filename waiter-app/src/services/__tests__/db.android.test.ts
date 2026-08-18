// Exercises the Android db.ts against a real SQLite engine.
//
// The Capacitor plugin is native, so it can't run here — but its JS contract is
// small and fully specified in its typings. This substitutes node:sqlite behind
// exactly that contract (including executeSet's all-or-nothing transaction), so
// the migrations and the replace* logic under test are the real shipped code.
//
// The headline case is the multi-branch pull: /api/mobile/pull returns dishes
// for every branch of the restaurant, and the old code deleted only
// dishes[0].branch_id before re-inserting all of them — a UNIQUE violation that
// rolled the transaction back and froze the menu from the second sync onward.

import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── node:sqlite behind the Capacitor SQLiteDBConnection contract ────────────

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
    // Mirrors the plugin's default transaction:true — the whole set commits or
    // none of it does. Without this the UNIQUE regression would not reproduce.
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

const dish = (id: string, branchId: string) => ({
  id,
  name: `Dish ${id}`,
  selling_price: 1000,
  category: 'Main',
  menu_type: 'food',
  is_active: 1,
  branch_id: branchId,
  restaurant_id: 'rest-1',
})

const table = (id: string, branchId: string) => ({
  id,
  name: `T-${id}`,
  seats: 4,
  status: 'available',
  branch_id: branchId,
  restaurant_id: 'rest-1',
})

describe('Android schema migrations', () => {
  beforeEach(() => vi.clearAllMocks())

  it('applies every migration on a fresh install', async () => {
    await freshDb()
    const names = fake.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name)

    // Through migration 10 — the tables the desktop gained that Android lacked.
    expect(names).toEqual(expect.arrayContaining([
      'dishes', 'restaurant_tables', 'orders', 'order_items', 'session',
      'app_logs', 'cancellation_approvers', 'order_code_holders',
      'mep_items', 'mep_catalog', 'mep_logs', 'shifts',
    ]))

    const applied = fake.db
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as { v: number }
    // 9 is the Credit/AR columns, 10 the order origin. The numbers differ from
    // the desktop's for the same migrations, because that app spent 9 on
    // guest_count, which Android has never had. What must hold is that a number
    // recorded on a device is never reused — reusing one means the migration
    // silently never runs.
    expect(applied.v).toBe(11)

    // Migration 10 — order origin, and whether this device has printed its
    // kitchen slips. Without `source` the till cannot tell which pending orders
    // came from a tablet and so still need pushing to paper by hand.
    // Migration 11 — the joined-order pointer, and the per-line discount.
    const orderCols = fake.db
      .prepare('PRAGMA table_info(orders)')
      .all()
      .map((c) => (c as { name: string }).name)
    expect(orderCols).toEqual(expect.arrayContaining([
      'source', 'tickets_pushed_at', 'merged_into_id',
    ]))

    // discount_percent drives what the guest is charged, and the same value
    // drives the journal entry and the dish sale on the server. If the column
    // is missing the app writes a price nothing recorded a discount against.
    const itemCols = fake.db
      .prepare('PRAGMA table_info(order_items)')
      .all()
      .map((c) => (c as { name: string }).name)
    expect(itemCols).toEqual(expect.arrayContaining(['discount_percent']))
  })

  it('adds the shift and station columns the server push expects', async () => {
    await freshDb()
    const cols = (t: string) =>
      fake.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => (c as { name: string }).name)

    // ar_customer_* ride on the order through push; without them a credit sale
    // syncs with no idea who owes the money.
    expect(cols('orders')).toEqual(expect.arrayContaining([
      'shift_id', 'business_date', 'ar_customer_name', 'ar_customer_phone',
    ]))
    expect(cols('order_items')).toEqual(expect.arrayContaining(['notes', 'branch_id']))
  })

  it('survives the duplicate menu_type column on a fresh install', async () => {
    // Migration 1's CREATE already includes menu_type while migration 2 adds it.
    // Unguarded, that threw "duplicate column name" and bricked new devices.
    await expect(freshDb()).resolves.toBeDefined()
    const cols = fake.db.prepare('PRAGMA table_info(dishes)').all().map((c) => (c as { name: string }).name)
    expect(cols.filter((c) => c === 'menu_type')).toHaveLength(1)
  })

  it('is idempotent when initDB runs again over an existing database', async () => {
    const mod = await freshDb()
    await expect(mod.initDB()).resolves.toBeUndefined()
  })
})

describe('replaceDishes — the multi-branch pull regression', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stores a dish set spanning several branches and survives a repeat pull', async () => {
    const { replaceDishes, getDishes } = await freshDb()

    // Exactly what /api/mobile/pull returns: restaurant-wide, many branch_ids.
    const payload = [dish('d1', 'branch-1'), dish('d2', 'branch-2'), dish('d3', 'branch-3')]

    await replaceDishes(payload, { restaurantId: 'rest-1' })
    expect(await getDishes()).toHaveLength(3)

    // The second pull is where the old code threw: it deleted only branch-1's
    // rows, then re-inserted d2/d3 on top of themselves.
    await expect(replaceDishes(payload, { restaurantId: 'rest-1' })).resolves.toBeUndefined()
    expect(await getDishes()).toHaveLength(3)

    // Ten pulls in a row must stay stable — this is the 10s auto-sync loop.
    for (let i = 0; i < 10; i += 1) await replaceDishes(payload, { restaurantId: 'rest-1' })
    expect(await getDishes()).toHaveLength(3)
  })

  it('reproduces the original failure when the delete is scoped to one branch', async () => {
    const { replaceDishes, getDishes } = await freshDb()
    const payload = [dish('d1', 'branch-1'), dish('d2', 'branch-2')]

    await replaceDishes(payload, { restaurantId: 'rest-1' })

    // The pre-fix scoping: delete branch-1 only, then re-insert everything.
    await expect(
      replaceDishes(payload, { branchId: 'branch-1', restaurantId: 'rest-1' }),
    ).rejects.toThrow(/UNIQUE/i)

    // And the rollback is why the menu froze: the old rows are still there,
    // unchanged, so the device keeps serving a stale menu indefinitely.
    expect(await getDishes()).toHaveLength(2)
  })

  it('drops dishes the restaurant no longer has', async () => {
    const { replaceDishes, getDishes } = await freshDb()

    await replaceDishes([dish('d1', 'branch-1'), dish('d2', 'branch-2')], { restaurantId: 'rest-1' })
    await replaceDishes([dish('d1', 'branch-1')], { restaurantId: 'rest-1' })

    const remaining = (await getDishes()).map((d) => d.id)
    expect(remaining).toEqual(['d1'])
  })

  it('leaves another restaurant\'s cached menu alone', async () => {
    const { replaceDishes, getDishes } = await freshDb()

    await replaceDishes([{ ...dish('other-1', 'branch-9'), restaurant_id: 'rest-2' }], { restaurantId: 'rest-2' })
    await replaceDishes([dish('d1', 'branch-1')], { restaurantId: 'rest-1' })

    expect((await getDishes()).map((d) => d.id).sort()).toEqual(['d1', 'other-1'])
  })
})

describe('replaceTables', () => {
  beforeEach(() => vi.clearAllMocks())

  it('replaces a restaurant-wide table set repeatedly without conflict', async () => {
    const { replaceTables, getTables } = await freshDb()
    const payload = [table('t1', 'branch-1'), table('t2', 'branch-2')]

    await replaceTables(payload, { restaurantId: 'rest-1' })
    await replaceTables(payload, { restaurantId: 'rest-1' })
    await replaceTables(payload, { restaurantId: 'rest-1' })

    expect(await getTables()).toHaveLength(2)
  })
})

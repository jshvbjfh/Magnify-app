// The shifts-enabled switch, against a real SQLite engine.
//
// This flag decides whether the till gates on a service shift and whether new
// orders get stamped with one, so the failure modes are asymmetric: wrongly
// reading "off" unlocks a venue that should be gated and silently strips
// attribution off its sales. The default therefore has to fail closed, which is
// what these tests pin down. Same node:sqlite substitution as the other suites —
// the code under test is the real shipped db.ts/shifts.ts.

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

// shifts.ts pulls the PIN validator from sync.ts, which drags in the HTTP and
// bcrypt stack. None of that is under test here, so it is stubbed out.
vi.mock('../sync', () => ({
  validateCancellationPinOffline: async () => ({ approvedBy: 'Supervisor' }),
}))

async function fresh() {
  vi.resetModules()
  fake = createFakeConnection()
  const db = await import('../db')
  await db.initDB()
  const shifts = await import('../shifts')
  return { ...db, ...shifts }
}

const T0 = '2026-08-16T08:00:00.000Z'

const openShiftRow = {
  id: 'shift-1',
  restaurant_id: 'rest-1',
  business_date: '2026-08-16T00:00:00.000Z',
  status: 'OPEN',
  opened_at: T0,
  opened_by_name: 'Supervisor',
  opened_by_staff_id: null,
  closed_at: null,
  closed_by_name: null,
  closed_by_staff_id: null,
  source_device_id: 'device-1',
  synced: 1,
  created_at: T0,
  updated_at: T0,
} as never

describe('areShiftsEnabled', () => {
  beforeEach(() => vi.clearAllMocks())

  it('defaults to enabled on a device that has never synced', async () => {
    const { areShiftsEnabled } = await fresh()
    // No cached value at all — the gate must stay up rather than fall open.
    expect(await areShiftsEnabled()).toBe(true)
  })

  it('stays enabled for any value other than an explicit "0"', async () => {
    const { areShiftsEnabled, setConfig } = await fresh()

    await setConfig('shiftsEnabled', '1')
    expect(await areShiftsEnabled()).toBe(true)

    // A server too old to send the flag leaves an empty string behind.
    await setConfig('shiftsEnabled', '')
    expect(await areShiftsEnabled()).toBe(true)
  })

  it('is disabled only when the pull stored "0"', async () => {
    const { areShiftsEnabled, setConfig } = await fresh()
    await setConfig('shiftsEnabled', '0')
    expect(await areShiftsEnabled()).toBe(false)
  })
})

describe('getActiveShift', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the open shift when the venue runs shifts', async () => {
    const { getActiveShift, saveShiftLocal, setConfig } = await fresh()
    await setConfig('restaurantId', 'rest-1')
    await setConfig('shiftsEnabled', '1')
    await saveShiftLocal(openShiftRow)

    expect((await getActiveShift())?.id).toBe('shift-1')
  })

  it('returns null when shifts are off, even with a shift row still open', async () => {
    const { getActiveShift, saveShiftLocal, setConfig } = await fresh()
    await setConfig('restaurantId', 'rest-1')
    await saveShiftLocal(openShiftRow)
    await setConfig('shiftsEnabled', '0')

    // Orders taken now must carry no shift, so they report by paidAt instead —
    // the leftover row must not silently re-attach itself to new sales.
    expect(await getActiveShift()).toBeNull()
  })
})

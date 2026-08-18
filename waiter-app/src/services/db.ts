// Capacitor SQLite bridge for the Android waiter app.
//
// Exposes the same run/query/executeSet surface the desktop POS gets from
// window.electronDB, so every service and page below this line is shared
// verbatim with waiter-app-desktop. Keep the two schemas identical — the sync
// endpoints and page components assume it.

import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite'

// ---- type helpers ----------------------------------------------------------

interface DBRow {
  [key: string]: unknown
}

type StatementSet = { statement: string; values: unknown[] }[]

// ---- connection ------------------------------------------------------------

const sqlite = new SQLiteConnection(CapacitorSQLite)
let connection: SQLiteDBConnection | null = null

const DB_NAME = 'magnify_waiter'
const DB_VERSION = 4

function requireConnection(): SQLiteDBConnection {
  if (!connection) throw new Error('DB not initialised — call initDB() first')
  return connection
}

// Adapter matching the desktop's window.electronDB shape: query() returns rows
// directly (Capacitor wraps them in { values }), and executeSet() runs all its
// statements in one transaction — the desktop main process does the same, which
// is why callers never pass explicit BEGIN/COMMIT.
function getDB() {
  const d = requireConnection()
  return {
    run: async (sql: string, params: unknown[] = []) => {
      const res = await d.run(sql, params as never[])
      return {
        changes: res.changes?.changes ?? 0,
        lastInsertRowid: res.changes?.lastId ?? 0,
      }
    },
    query: async (sql: string, params: unknown[] = []): Promise<DBRow[]> => {
      const res = await d.query(sql, params as never[])
      return (res.values ?? []) as DBRow[]
    },
    executeSet: async (statements: StatementSet) => {
      if (!statements.length) return { changes: 0 }
      const res = await d.executeSet(statements as never[])
      return { changes: res.changes?.changes ?? 0 }
    },
  }
}

// ---- schema migrations -----------------------------------------------------
// Versions 1–5 are the schema the shipped APK already applied; their numbers are
// fixed history and must never change. 6–8 bring Android up to the desktop
// schema (MEP, per-item station stamp, shifts).

interface Migration {
  version: number
  sql?: string
  run?: (d: SQLiteDBConnection) => Promise<void>
}

// ALTERs must be guarded: migration 1's CREATE already bakes some of these
// columns in on fresh installs, so a blind ADD COLUMN fails with "duplicate
// column name" and leaves a brand-new device unable to start.
async function addColumnIfMissing(
  d: SQLiteDBConnection,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  try {
    const res = await d.query(`PRAGMA table_info(${table})`)
    const columns = res.values ?? []
    // An empty result means PRAGMA didn't report through this transport rather
    // than "no columns" — fall through to the guarded ALTER instead of trusting it.
    if (columns.length > 0 && columns.some((c) => (c as { name?: string }).name === column)) return
  } catch {
    // PRAGMA unavailable — fall through to the guarded ALTER below.
  }

  try {
    await d.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`)
  } catch (err) {
    // The column already exists. This is the expected outcome on a fresh install,
    // where migration 1's CREATE already baked the column in. Any other failure
    // is a real migration error and must not be swallowed.
    const message = err instanceof Error ? err.message : String(err)
    if (!/duplicate column name/i.test(message)) throw err
  }
}

const MIGRATIONS: Migration[] = [
  {
    // Initial schema — all CREATE TABLE IF NOT EXISTS, safe for existing installs.
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS dishes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  selling_price REAL NOT NULL,
  category TEXT,
  menu_type TEXT,
  is_active INTEGER DEFAULT 1,
  branch_id TEXT,
  restaurant_id TEXT
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seats INTEGER,
  status TEXT DEFAULT 'available',
  branch_id TEXT,
  restaurant_id TEXT
);

CREATE TABLE IF NOT EXISTS restaurant_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  branch_id TEXT,
  table_id TEXT,
  table_name TEXT,
  order_number TEXT,
  status TEXT DEFAULT 'PENDING',
  payment_method TEXT,
  subtotal_amount REAL DEFAULT 0,
  vat_amount REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  created_by_name TEXT,
  served_at TEXT,
  paid_at TEXT,
  canceled_at TEXT,
  cancel_reason TEXT,
  synced INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  dish_id TEXT NOT NULL,
  dish_name TEXT NOT NULL,
  dish_price REAL NOT NULL,
  qty INTEGER NOT NULL,
  status TEXT DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_logs (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cancellation_approvers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    run: (d) => addColumnIfMissing(d, 'dishes', 'menu_type', 'TEXT'),
  },
  {
    version: 3,
    run: (d) => addColumnIfMissing(d, 'orders', 'sync_error', 'TEXT'),
  },
  {
    version: 4,
    run: (d) => addColumnIfMissing(d, 'order_items', 'notes', 'TEXT'),
  },
  {
    version: 5,
    sql: `CREATE TABLE IF NOT EXISTS order_code_holders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL
);`,
  },
  {
    // MEP (mise en place): per-station prep list, prep catalog for search, and
    // the offline "qty prepared" log queue (id doubles as the server clientLogId).
    version: 6,
    sql: `
CREATE TABLE IF NOT EXISTS mep_items (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  branch_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT,
  remaining REAL DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS mep_catalog (
  target_id TEXT PRIMARY KEY,
  branch_id TEXT,
  name TEXT NOT NULL,
  unit TEXT,
  remaining REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mep_logs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  branch_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  name TEXT,
  quantity REAL NOT NULL,
  made_by TEXT,
  made_at TEXT NOT NULL,
  reversed INTEGER DEFAULT 0,
  pending_undo INTEGER DEFAULT 0,
  synced INTEGER DEFAULT 0,
  sync_error TEXT
);
`,
  },
  {
    // Station snapshot at order-creation time, so a dish reassigned to a
    // different station while an order sits open can't retroactively
    // misattribute the sale.
    version: 7,
    run: (d) => addColumnIfMissing(d, 'order_items', 'branch_id', 'TEXT'),
  },
  {
    // Shifts (service sessions) — a supervisor opens/closes the venue for the
    // day. Every order rung up while a shift is open is stamped with its id and
    // business_date, so a table paid after midnight still counts on the shift's
    // day.
    version: 8,
    sql: `
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  opened_at TEXT NOT NULL,
  opened_by_name TEXT,
  opened_by_staff_id TEXT,
  closed_at TEXT,
  closed_by_name TEXT,
  closed_by_staff_id TEXT,
  source_device_id TEXT,
  synced INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
    run: async (d) => {
      await addColumnIfMissing(d, 'orders', 'shift_id', 'TEXT')
      await addColumnIfMissing(d, 'orders', 'business_date', 'TEXT')
    },
  },
  {
    // Which app took the order, and whether its kitchen tickets have been sent
    // to paper yet.
    //
    // `source` is 'tablet' or 'desktop', stamped at creation and synced. The
    // tablet cannot print, so a ticket for an order it took never reaches the
    // kitchen by itself; the till uses this to find the orders that still need
    // pushing. Null on every order taken before this existed, which reads as
    // "not from a tablet" — correct for history, and it stops the feature
    // offering to reprint the past.
    //
    // `tickets_pushed_at` is deliberately LOCAL and never synced: it records
    // that THIS terminal's printers have already produced the slips. Two tills
    // at one venue each keep their own answer, because paper coming out of one
    // says nothing about the other.
    // Numbered 10, not 9, on purpose: the desktop already used 9 for
    // orders.guest_count, which Android has never had. Taking 10 in both apps
    // keeps this migration meaning the same thing on each, instead of stacking
    // a second meaning onto a number that has already diverged. The gap at 9 is
    // harmless — the runner applies anything above the highest applied version.
    version: 10,
    run: async (d) => {
      await addColumnIfMissing(d, 'orders', 'source', 'TEXT')
      await addColumnIfMissing(d, 'orders', 'tickets_pushed_at', 'TEXT')
    },
  },
]

// ---- db init ---------------------------------------------------------------

export async function initDB(): Promise<void> {
  if (connection) return

  const isConsistent = await sqlite.checkConnectionsConsistency()
  const isConn = (await sqlite.isConnection(DB_NAME, false)).result

  if (isConsistent.result && isConn) {
    connection = await sqlite.retrieveConnection(DB_NAME, false)
  } else {
    connection = await sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false)
  }

  await connection.open()
  await runMigrations()
}

async function runMigrations(): Promise<void> {
  const d = requireConnection()

  // Bootstrap the migrations tracking table.
  await d.execute(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
  `)

  const res = await d.query('SELECT COALESCE(MAX(version), 0) AS max_v FROM schema_migrations')
  const maxApplied: number = ((res.values?.[0] as { max_v: number } | undefined)?.max_v) ?? 0

  for (const migration of MIGRATIONS) {
    if (migration.version <= maxApplied) continue
    if (migration.sql) await d.execute(migration.sql)
    if (migration.run) await migration.run(d)
    await d.run(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      [migration.version, new Date().toISOString()],
    )
  }
}

// ---- session (key-value store) ---------------------------------------------
// Matches the Android waiter-app: session table has (key TEXT PK, value TEXT).

export async function setSession(key: string, value: string): Promise<void> {
  const db = getDB()
  await db.run(
    'INSERT OR REPLACE INTO session (key, value) VALUES (?, ?)',
    [key, value],
  )
}

export async function getSession(key: string): Promise<string | null> {
  const db = getDB()
  const rows = await db.query('SELECT value FROM session WHERE key = ?', [key])
  if (!rows || rows.length === 0) return null
  return (rows[0] as DBRow).value as string
}

export async function clearSession(): Promise<void> {
  const db = getDB()
  await db.run('DELETE FROM session', [])
}

export async function clearLocalMenu(): Promise<void> {
  const db = getDB()
  await db.run('DELETE FROM dishes', [])
  await db.run('DELETE FROM restaurant_tables', [])
}

// ---- app_logs --------------------------------------------------------------

export interface AppLogEntry {
  id: string
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
  details: string | null
  created_at: string
}

export async function createLogEntry(entry: AppLogEntry): Promise<void> {
  const db = getDB()
  await db.run(
    'INSERT OR REPLACE INTO app_logs (id, level, scope, message, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [entry.id, entry.level, entry.scope, entry.message, entry.details, entry.created_at],
  )
}

export async function getLogEntries(limit = 200): Promise<AppLogEntry[]> {
  const safeLimit = Math.max(1, Math.floor(limit))
  const db = getDB()
  const rows = await db.query(
    `SELECT * FROM app_logs ORDER BY created_at DESC LIMIT ${safeLimit}`,
    [],
  )
  return (rows ?? []) as unknown as AppLogEntry[]
}

export async function clearLogEntries(): Promise<void> {
  const db = getDB()
  await db.run('DELETE FROM app_logs', [])
}

// ---- restaurant_config -----------------------------------------------------

export async function setConfig(key: string, value: string): Promise<void> {
  const db = getDB()
  await db.run(
    'INSERT OR REPLACE INTO restaurant_config (key, value) VALUES (?, ?)',
    [key, value],
  )
}

export async function getConfig(key: string): Promise<string | null> {
  const db = getDB()
  const rows = await db.query('SELECT value FROM restaurant_config WHERE key = ?', [key])
  if (!rows || rows.length === 0) return null
  return (rows[0] as DBRow).value as string
}

interface ReplaceScope {
  branchId?: string | null
  restaurantId?: string | null
}

function normalizeScopeId(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || null
}

function buildScopedDeleteStatement(
  tableName: 'dishes' | 'restaurant_tables',
  scope: ReplaceScope,
): { statement: string; values: unknown[] } | null {
  const branchId = normalizeScopeId(scope.branchId)
  const restaurantId = normalizeScopeId(scope.restaurantId)

  if (branchId && restaurantId) {
    return {
      statement: `DELETE FROM ${tableName} WHERE branch_id = ? AND restaurant_id = ?`,
      values: [branchId, restaurantId],
    }
  }

  if (branchId) {
    return {
      statement: `DELETE FROM ${tableName} WHERE branch_id = ?`,
      values: [branchId],
    }
  }

  if (restaurantId) {
    return {
      statement: `DELETE FROM ${tableName} WHERE restaurant_id = ?`,
      values: [restaurantId],
    }
  }

  return null
}

// ---- dishes ----------------------------------------------------------------

export interface Dish {
  id: string
  name: string
  selling_price: number
  category: string | null
  menu_type: string | null
  is_active: number
  branch_id: string | null
  restaurant_id: string | null
}

export async function replaceDishes(dishes: Dish[], scope: ReplaceScope = {}): Promise<void> {
  // Use explicit scope for the delete — never derive branchId from dishes[0] because the
  // pull API returns all restaurant dishes (spanning every branch). Scoping the delete to
  // one arbitrary branch leaves other branches' dishes in SQLite and causes UNIQUE failures
  // on the next sync when we try to re-insert them.
  const deleteStatement = buildScopedDeleteStatement('dishes', {
    branchId: scope.branchId ?? null,
    restaurantId: scope.restaurantId ?? dishes[0]?.restaurant_id ?? null,
  })

  if (!dishes.length) {
    if (!deleteStatement) {
      console.warn('[replaceDishes] received empty dishes array without branch or restaurant scope — skipping replace to preserve local data')
      return
    }

    const db = getDB()
    await db.run(deleteStatement.statement, deleteStatement.values)
    return
  }

  const db = getDB()
  if (deleteStatement) {
    await db.executeSet([
      deleteStatement,
      ...dishes.map((d) => ({
        statement:
          'INSERT INTO dishes (id, name, selling_price, category, menu_type, is_active, branch_id, restaurant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        values: [d.id, d.name, d.selling_price, d.category, d.menu_type, d.is_active ? 1 : 0, d.branch_id, d.restaurant_id],
      })),
    ])
  } else {
    await db.executeSet([
      { statement: 'DELETE FROM dishes', values: [] },
      ...dishes.map((d) => ({
        statement:
          'INSERT INTO dishes (id, name, selling_price, category, menu_type, is_active, branch_id, restaurant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        values: [d.id, d.name, d.selling_price, d.category, d.menu_type, d.is_active ? 1 : 0, d.branch_id, d.restaurant_id],
      })),
    ])
  }
}

export async function getDishes(branchId?: string | null): Promise<Dish[]> {
  const db = getDB()
  const normalized = typeof branchId === 'string' ? branchId.trim() : ''
  if (normalized) {
    const rows = await db.query(
      'SELECT * FROM dishes WHERE is_active = 1 AND branch_id = ? ORDER BY name',
      [normalized],
    )
    return (rows ?? []) as unknown as Dish[]
  }
  const rows = await db.query('SELECT * FROM dishes WHERE is_active = 1 ORDER BY name', [])
  return (rows ?? []) as unknown as Dish[]
}

// ---- restaurant_tables -----------------------------------------------------

export interface RestaurantTable {
  id: string
  name: string
  seats: number | null
  status: string
  branch_id: string | null
  restaurant_id: string | null
}

export async function replaceTables(tables: RestaurantTable[], scope: ReplaceScope = {}): Promise<void> {
  // Always scope DELETE by restaurant only — never by branch — so that all
  // branches for this restaurant are replaced atomically and stale tables from
  // a previous login to a different restaurant are never left behind.
  const restaurantId = scope.restaurantId ?? tables[0]?.restaurant_id ?? null
  const deleteStatement = buildScopedDeleteStatement('restaurant_tables', {
    restaurantId,
  })

  if (!tables.length) {
    if (!deleteStatement) {
      console.warn('[replaceTables] received empty tables array without branch or restaurant scope — skipping replace to preserve local data')
      return
    }

    const db = getDB()
    await db.run(deleteStatement.statement, deleteStatement.values)
    return
  }

  const db = getDB()
  if (deleteStatement) {
    await db.executeSet([
      deleteStatement,
      ...tables.map((t) => ({
        statement:
          'INSERT INTO restaurant_tables (id, name, seats, status, branch_id, restaurant_id) VALUES (?, ?, ?, ?, ?, ?)',
        values: [t.id, t.name, t.seats, t.status ?? 'available', t.branch_id, t.restaurant_id],
      })),
    ])
  } else {
    await db.executeSet([
      { statement: 'DELETE FROM restaurant_tables', values: [] },
      ...tables.map((t) => ({
        statement:
          'INSERT INTO restaurant_tables (id, name, seats, status, branch_id, restaurant_id) VALUES (?, ?, ?, ?, ?, ?)',
        values: [t.id, t.name, t.seats, t.status ?? 'available', t.branch_id, t.restaurant_id],
      })),
    ])
  }
}

export async function getTables(branchId?: string | null): Promise<RestaurantTable[]> {
  const db = getDB()
  const normalized = typeof branchId === 'string' ? branchId.trim() : ''
  if (normalized) {
    const rows = await db.query(
      'SELECT * FROM restaurant_tables WHERE branch_id = ? ORDER BY name',
      [normalized],
    )
    return (rows ?? []) as unknown as RestaurantTable[]
  }
  const rows = await db.query('SELECT * FROM restaurant_tables ORDER BY name', [])
  return (rows ?? []) as unknown as RestaurantTable[]
}

export async function updateTableStatus(tableId: string, status: string): Promise<void> {
  const db = getDB()
  await db.run('UPDATE restaurant_tables SET status = ? WHERE id = ?', [status, tableId])
}

// ---- orders ----------------------------------------------------------------

// Which app this build is, stamped onto every order it creates. This is the
// one thing the two waiter apps must genuinely disagree about: the till can
// print and the Android tablet cannot, so the pending list uses it to show a Push
// button only for orders whose tickets no printer has ever seen.
export const ORDER_SOURCE = 'tablet'

export interface Order {
  id: string
  restaurant_id: string
  branch_id: string | null
  table_id: string | null
  table_name: string | null
  order_number: string | null
  status: string
  payment_method: string | null
  subtotal_amount: number
  vat_amount: number
  total_amount: number
  created_by_name: string | null
  served_at: string | null
  paid_at: string | null
  canceled_at: string | null
  cancel_reason: string | null
  shift_id: string | null
  business_date: string | null
  // Which app took the order: 'tablet' or 'desktop'. Null on orders taken
  // before this existed and on guest QR orders — read that as 'not a tablet'.
  source: string | null
  // LOCAL ONLY, never synced: when THIS terminal's printers produced the
  // kitchen slips for this order. See migration 10.
  tickets_pushed_at: string | null
  synced: number
  sync_error: string | null
  created_at: string
  updated_at: string
}

export interface OrderItem {
  id: string
  order_id: string
  dish_id: string
  dish_name: string
  dish_price: number
  qty: number
  status: string
  notes: string | null
  branch_id: string | null
  created_at: string
  updated_at: string
}

export async function createOrder(order: Order, items: OrderItem[]): Promise<void> {
  const db = getDB()
  const statements: StatementSet = [
    {
      statement: `INSERT INTO orders
        (id, restaurant_id, branch_id, table_id, table_name, order_number, status,
         payment_method, subtotal_amount, vat_amount, total_amount, created_by_name,
         served_at, paid_at, canceled_at, cancel_reason, shift_id, business_date, source, synced, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      values: [
        order.id, order.restaurant_id, order.branch_id, order.table_id, order.table_name,
        order.order_number, order.status, order.payment_method, order.subtotal_amount,
        order.vat_amount, order.total_amount, order.created_by_name,
        order.served_at, order.paid_at, order.canceled_at, order.cancel_reason,
        order.shift_id ?? null, order.business_date ?? null, order.source ?? null,
        order.created_at, order.updated_at,
      ],
    },
    ...items.map((item) => ({
      statement:
        'INSERT INTO order_items (id, order_id, dish_id, dish_name, dish_price, qty, status, notes, branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      values: [item.id, item.order_id, item.dish_id, item.dish_name, item.dish_price, item.qty, item.status, item.notes ?? null, item.branch_id ?? null, item.created_at, item.updated_at],
    })),
  ]
  await db.executeSet(statements)
}

// Append items to an existing (already confirmed) order — the edit-pending
// flow. The caller updates order totals afterwards, which marks the order
// unsynced so the next push re-sends it with the new items.
export async function addOrderItems(items: OrderItem[]): Promise<void> {
  if (!items.length) return
  const db = getDB()
  await db.executeSet(items.map((item) => ({
    statement:
      'INSERT INTO order_items (id, order_id, dish_id, dish_name, dish_price, qty, status, notes, branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    values: [item.id, item.order_id, item.dish_id, item.dish_name, item.dish_price, item.qty, item.status, item.notes ?? null, item.branch_id ?? null, item.created_at, item.updated_at],
  })))
}

export async function getOrderById(orderId: string): Promise<Order | null> {
  const db = getDB()
  const rows = await db.query('SELECT * FROM orders WHERE id = ?', [orderId])
  return ((rows ?? [])[0] as unknown as Order) ?? null
}

export async function updateOrder(
  orderId: string,
  fields: Partial<Pick<Order, 'status' | 'payment_method' | 'served_at' | 'paid_at' | 'canceled_at' | 'cancel_reason' | 'subtotal_amount' | 'vat_amount' | 'total_amount' | 'created_by_name'>>,
): Promise<void> {
  const now = new Date().toISOString()
  const entries = Object.entries({ ...fields, updated_at: now, synced: 0 })
  const setClauses = entries.map(([k]) => `${k} = ?`).join(', ')
  const values = entries.map(([, v]) => v)
  const db = getDB()
  await db.run(`UPDATE orders SET ${setClauses} WHERE id = ?`, [...values, orderId])
}

// Record that THIS terminal's printers produced the kitchen slips for an order.
//
// Deliberately not routed through updateOrder: that stamps updated_at and sets
// synced = 0, which would push the row back to the server as if the order had
// changed. Nothing about the order did change — only this machine's knowledge of
// what it has printed, which is local and never leaves the device.
export async function markTicketsPushed(orderId: string): Promise<void> {
  const db = getDB()
  await db.run(
    'UPDATE orders SET tickets_pushed_at = ? WHERE id = ?',
    [new Date().toISOString(), orderId],
  )
}

export async function getOrders(filter?: { status?: string; statuses?: string[]; branchId?: string | null; restaurantId?: string | null }): Promise<Order[]> {
  const db = getDB()
  const clauses: string[] = []
  const values: unknown[] = []

  const normalizedRestaurantId = typeof filter?.restaurantId === 'string' ? filter.restaurantId.trim() : ''
  if (normalizedRestaurantId) {
    clauses.push('restaurant_id = ?')
    values.push(normalizedRestaurantId)
  }

  if (filter?.statuses && filter.statuses.length > 0) {
    clauses.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`)
    values.push(...filter.statuses)
  } else if (filter?.status) {
    clauses.push('status = ?')
    values.push(filter.status)
  }

  const normalizedBranchId = typeof filter?.branchId === 'string' ? filter.branchId.trim() : ''
  if (normalizedBranchId) {
    clauses.push('branch_id = ?')
    values.push(normalizedBranchId)
  }

  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  const rows = await db.query(`SELECT * FROM orders${whereClause} ORDER BY created_at DESC`, values)
  return (rows ?? []) as unknown as Order[]
}

export async function getOrderItems(orderId: string): Promise<OrderItem[]> {
  const db = getDB()
  const rows = await db.query('SELECT * FROM order_items WHERE order_id = ?', [orderId])
  return (rows ?? []) as unknown as OrderItem[]
}

// Purge local copies of active orders the server no longer has (hard-deleted
// upstream, e.g. an owner removing a mistake order). Only touches orders the
// server has already acknowledged (synced = 1) — unpushed local orders are
// never destroyed. Returns how many orders were removed.
export async function deleteServerRemovedOrders(restaurantId: string, serverOrderIds: string[]): Promise<number> {
  const db = getDB()
  const rows = (await db.query(
    `SELECT id FROM orders WHERE restaurant_id = ? AND synced = 1 AND status IN ('PENDING', 'OPEN', 'UNCONFIRMED')`,
    [restaurantId],
  )) as unknown as Array<{ id: string }>
  const keep = new Set(serverOrderIds)
  const removedIds = rows.map(r => r.id).filter(id => !keep.has(id))
  for (const id of removedIds) {
    await db.run('DELETE FROM order_items WHERE order_id = ?', [id])
    await db.run('DELETE FROM orders WHERE id = ?', [id])
  }
  return removedIds.length
}

export async function getUnsyncedOrders(): Promise<{ orders: Order[]; items: OrderItem[] }> {
  const db = getDB()
  const orders = (await db.query('SELECT * FROM orders WHERE synced = 0', [])) as unknown as Order[]
  const items: OrderItem[] = []
  for (const order of orders) {
    const orderItems = (await db.query('SELECT * FROM order_items WHERE order_id = ?', [order.id])) as unknown as OrderItem[]
    items.push(...orderItems)
  }
  return { orders, items }
}

export async function markOrdersSynced(orders: Array<{ id: string; updated_at: string }>): Promise<void> {
  if (!orders.length) return
  const db = getDB()
  for (const order of orders) {
    await db.run(
      'UPDATE orders SET synced = 1, sync_error = NULL WHERE id = ? AND updated_at = ?',
      [order.id, order.updated_at],
    )
  }
}

export async function updateOrderSyncError(orderId: string, error: string | null): Promise<void> {
  const db = getDB()
  await db.run('UPDATE orders SET sync_error = ? WHERE id = ?', [error, orderId])
}

export interface RemoteOrderStatus {
  id: string
  status: string
  payment_method: string | null
  paid_at: string | null
  canceled_at: string | null
  cancel_reason: string | null
  updated_at: string
}

// Applies server-authoritative status changes from pull without marking orders
// for re-push (synced stays 1). Only updates rows that exist locally AND whose
// server updated_at is newer than the local updated_at.
export async function reconcileOrderStatuses(remoteOrders: RemoteOrderStatus[]): Promise<void> {
  if (!remoteOrders.length) return
  const db = getDB()
  for (const remote of remoteOrders) {
    await db.run(
      `UPDATE orders
       SET status = ?, payment_method = ?, paid_at = ?, canceled_at = ?, cancel_reason = ?, updated_at = ?
       WHERE id = ? AND updated_at < ?`,
      [
        remote.status,
        remote.payment_method,
        remote.paid_at,
        remote.canceled_at,
        remote.cancel_reason,
        remote.updated_at,
        remote.id,
        remote.updated_at,
      ],
    )
  }
}

// Inserts cloud-originated orders (QR/guest) the waiter device doesn't have locally.
// INSERT OR IGNORE preserves any locally-created order with the same ID.
// synced=1 so these are never re-pushed to the server.
export interface IncomingOrderItem {
  id: string; order_id: string; dish_id: string; dish_name: string
  dish_price: number; qty: number; status: string; notes?: string | null; created_at: string; updated_at: string
}
export interface IncomingOrder {
  id: string; restaurant_id: string; branch_id: string | null; table_id: string | null
  table_name: string | null; order_number: string; status: string; payment_method: string | null
  subtotal_amount: number; vat_amount: number; total_amount: number; created_by_name: string | null
  paid_at: string | null; canceled_at: string | null; cancel_reason: string | null
  // 'tablet' | 'desktop' | null. Null covers guest QR orders and anything from
  // a client too old to send it.
  source?: string | null
  created_at: string; updated_at: string; items: IncomingOrderItem[]
}
export async function upsertIncomingOrders(orders: IncomingOrder[]): Promise<void> {
  if (!orders.length) return
  const db = getDB()
  for (const order of orders) {
    const statements: StatementSet = [
      {
        statement: `INSERT OR IGNORE INTO orders
          (id, restaurant_id, branch_id, table_id, table_name, order_number, status,
           payment_method, subtotal_amount, vat_amount, total_amount, created_by_name,
           served_at, paid_at, canceled_at, cancel_reason, source, synced, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?)`,
        values: [
          order.id, order.restaurant_id, order.branch_id, order.table_id, order.table_name,
          order.order_number, order.status, order.payment_method, order.subtotal_amount,
          order.vat_amount, order.total_amount, order.created_by_name,
          order.paid_at, order.canceled_at, order.cancel_reason, order.source ?? null,
          order.created_at, order.updated_at,
        ],
      },
      ...order.items.map((item) => ({
        statement: `INSERT OR IGNORE INTO order_items
          (id, order_id, dish_id, dish_name, dish_price, qty, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values: [item.id, item.order_id, item.dish_id, item.dish_name, item.dish_price, item.qty, item.status, item.notes ?? null, item.created_at, item.updated_at],
      })),
    ]
    await db.executeSet(statements)
  }
}

// ---- cancellation_approvers ------------------------------------------------
// Pulled from server on every pullSync. Stores id, name, and bcrypt hash only.
// No PINs in plaintext — offline validation uses bcrypt.compare() locally.

export interface CancellationApprover {
  id: string
  name: string
  pin_hash: string
}

export async function replaceCancellationApprovers(approvers: CancellationApprover[]): Promise<void> {
  const db = getDB()
  const statements: StatementSet = [
    { statement: 'DELETE FROM cancellation_approvers', values: [] },
    ...approvers.map((a) => ({
      statement: 'INSERT INTO cancellation_approvers (id, name, pin_hash) VALUES (?, ?, ?)',
      values: [a.id, a.name, a.pin_hash],
    })),
  ]
  await db.executeSet(statements)
}

export async function getCancellationApprovers(): Promise<CancellationApprover[]> {
  const db = getDB()
  const rows = await db.query('SELECT * FROM cancellation_approvers ORDER BY name', [])
  return (rows ?? []) as unknown as CancellationApprover[]
}

// ---- order_code_holders ----------------------------------------------------
// Pulled from server on every pullSync. Stores id, name, and bcrypt hash of
// the 4-digit order code. Separate from cancellation_approvers.

export async function replaceOrderCodeHolders(holders: CancellationApprover[]): Promise<void> {
  const db = getDB()
  const statements: StatementSet = [
    { statement: 'DELETE FROM order_code_holders', values: [] },
    ...holders.map((h) => ({
      statement: 'INSERT INTO order_code_holders (id, name, pin_hash) VALUES (?, ?, ?)',
      values: [h.id, h.name, h.pin_hash],
    })),
  ]
  await db.executeSet(statements)
}

export async function getOrderCodeHolders(): Promise<CancellationApprover[]> {
  const db = getDB()
  const rows = await db.query('SELECT * FROM order_code_holders ORDER BY name', [])
  return (rows ?? []) as unknown as CancellationApprover[]
}

// ---- shifts (service sessions) ---------------------------------------------
// A shift is opened/closed by a supervisor and stamped onto every order taken
// while it's open. Created locally (synced=0), pushed to the server, and the
// server's current open shift is mirrored back on pull so every terminal agrees
// on whether the venue is open.

export interface Shift {
  id: string
  restaurant_id: string
  business_date: string
  status: string
  opened_at: string
  opened_by_name: string | null
  opened_by_staff_id: string | null
  closed_at: string | null
  closed_by_name: string | null
  closed_by_staff_id: string | null
  source_device_id: string | null
  synced: number
  created_at: string
  updated_at: string
}

// The one OPEN shift for this restaurant, if any. Prefers the earliest-opened
// so it matches the server's tie-break when two ever exist.
export async function getOpenShift(restaurantId?: string | null): Promise<Shift | null> {
  const db = getDB()
  const rid = normalizeScopeId(restaurantId ?? null)
  const rows = rid
    ? await db.query("SELECT * FROM shifts WHERE status = 'OPEN' AND restaurant_id = ? ORDER BY opened_at ASC LIMIT 1", [rid])
    : await db.query("SELECT * FROM shifts WHERE status = 'OPEN' ORDER BY opened_at ASC LIMIT 1", [])
  return rows && rows.length ? (rows[0] as unknown as Shift) : null
}

// Persist a locally-created or locally-closed shift (marks it unsynced).
export async function saveShiftLocal(shift: Shift): Promise<void> {
  const db = getDB()
  await db.run(
    `INSERT OR REPLACE INTO shifts
      (id, restaurant_id, business_date, status, opened_at, opened_by_name, opened_by_staff_id,
       closed_at, closed_by_name, closed_by_staff_id, source_device_id, synced, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      shift.id, shift.restaurant_id, shift.business_date, shift.status, shift.opened_at,
      shift.opened_by_name ?? null, shift.opened_by_staff_id ?? null,
      shift.closed_at ?? null, shift.closed_by_name ?? null, shift.closed_by_staff_id ?? null,
      shift.source_device_id ?? null, shift.created_at, shift.updated_at,
    ],
  )
}

export async function getUnsyncedShifts(): Promise<Shift[]> {
  const db = getDB()
  const rows = await db.query('SELECT * FROM shifts WHERE synced = 0', [])
  return (rows ?? []) as unknown as Shift[]
}

export async function markShiftsSynced(ids: string[]): Promise<void> {
  if (!ids.length) return
  const db = getDB()
  for (const id of ids) {
    await db.run('UPDATE shifts SET synced = 1 WHERE id = ?', [id])
  }
}

// Mirror the server's open shift into the local table. Never clobbers a shift
// that still has unsynced local changes (synced=0) — the push will reconcile it.
export async function upsertShiftFromServer(shift: Shift): Promise<void> {
  const db = getDB()
  const existing = await db.query('SELECT synced FROM shifts WHERE id = ?', [shift.id])
  if (existing && existing.length && Number((existing[0] as DBRow).synced) === 0) return
  await db.run(
    `INSERT OR REPLACE INTO shifts
      (id, restaurant_id, business_date, status, opened_at, opened_by_name, opened_by_staff_id,
       closed_at, closed_by_name, closed_by_staff_id, source_device_id, synced, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      shift.id, shift.restaurant_id, shift.business_date, shift.status, shift.opened_at,
      shift.opened_by_name ?? null, shift.opened_by_staff_id ?? null,
      shift.closed_at ?? null, shift.closed_by_name ?? null, shift.closed_by_staff_id ?? null,
      shift.source_device_id ?? null, shift.created_at, shift.updated_at,
    ],
  )
}

// When the server reports NO open shift, close any local shift still marked OPEN
// but already synced — another terminal closed it. Unsynced local opens are left
// alone so this device's own just-opened shift isn't wiped before it pushes.
export async function reconcileNoOpenShift(restaurantId: string): Promise<void> {
  const db = getDB()
  await db.run(
    "UPDATE shifts SET status = 'CLOSED' WHERE restaurant_id = ? AND status = 'OPEN' AND synced = 1",
    [restaurantId],
  )
}

// ---- MEP (mise en place) ----------------------------------------------------
// mep_items: this station's persistent MEP list (server-authoritative, replaced
// on pull). mep_catalog: preps available in the search box. mep_logs: local
// "qty prepared" queue — id doubles as the server clientLogId, synced=0 rows are
// pushed by pushMepSync.

export interface MepItem {
  id: string
  restaurant_id: string | null
  branch_id: string | null
  target_type: 'prep' | 'dish'
  target_id: string
  name: string
  unit: string | null
  remaining: number
  updated_at: string | null
}

export interface MepCatalogEntry {
  target_id: string
  branch_id: string | null
  name: string
  unit: string | null
  remaining: number
}

export interface MepLog {
  id: string
  restaurant_id: string | null
  branch_id: string | null
  target_type: 'prep' | 'dish'
  target_id: string
  name: string | null
  quantity: number
  made_by: string | null
  made_at: string
  reversed: number
  pending_undo: number
  synced: number
  sync_error: string | null
}

export async function replaceMepItems(items: MepItem[], branchId: string): Promise<void> {
  const normalizedBranchId = normalizeScopeId(branchId)
  if (!normalizedBranchId) return
  const db = getDB()
  await db.executeSet([
    { statement: 'DELETE FROM mep_items WHERE branch_id = ?', values: [normalizedBranchId] },
    ...items.map((item) => ({
      statement:
        'INSERT OR REPLACE INTO mep_items (id, restaurant_id, branch_id, target_type, target_id, name, unit, remaining, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      values: [item.id, item.restaurant_id, item.branch_id, item.target_type, item.target_id, item.name, item.unit, item.remaining, item.updated_at],
    })),
  ])
}

export async function replaceMepCatalog(preps: MepCatalogEntry[], branchId: string): Promise<void> {
  const normalizedBranchId = normalizeScopeId(branchId)
  if (!normalizedBranchId) return
  const db = getDB()
  await db.executeSet([
    { statement: 'DELETE FROM mep_catalog WHERE branch_id = ? OR branch_id IS NULL', values: [normalizedBranchId] },
    ...preps.map((prep) => ({
      statement: 'INSERT OR REPLACE INTO mep_catalog (target_id, branch_id, name, unit, remaining) VALUES (?, ?, ?, ?, ?)',
      values: [prep.target_id, normalizedBranchId, prep.name, prep.unit, prep.remaining],
    })),
  ])
}

export async function getMepItems(branchId?: string | null): Promise<MepItem[]> {
  const db = getDB()
  const normalized = normalizeScopeId(branchId)
  const rows = normalized
    ? await db.query('SELECT * FROM mep_items WHERE branch_id = ? ORDER BY name', [normalized])
    : await db.query('SELECT * FROM mep_items ORDER BY name', [])
  return (rows ?? []) as unknown as MepItem[]
}

export async function getMepCatalog(branchId?: string | null): Promise<MepCatalogEntry[]> {
  const db = getDB()
  const normalized = normalizeScopeId(branchId)
  const rows = normalized
    ? await db.query('SELECT * FROM mep_catalog WHERE branch_id = ? ORDER BY name', [normalized])
    : await db.query('SELECT * FROM mep_catalog ORDER BY name', [])
  return (rows ?? []) as unknown as MepCatalogEntry[]
}

export async function upsertMepItem(item: MepItem): Promise<void> {
  const db = getDB()
  await db.run(
    'INSERT OR REPLACE INTO mep_items (id, restaurant_id, branch_id, target_type, target_id, name, unit, remaining, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [item.id, item.restaurant_id, item.branch_id, item.target_type, item.target_id, item.name, item.unit, item.remaining, item.updated_at],
  )
}

export async function deleteMepItem(id: string): Promise<void> {
  const db = getDB()
  await db.run('DELETE FROM mep_items WHERE id = ?', [id])
}

// Optimistic "remaining" adjustment; clamped at 0 like the server.
export async function adjustMepRemaining(targetType: string, targetId: string, delta: number): Promise<void> {
  const db = getDB()
  await db.run(
    'UPDATE mep_items SET remaining = MAX(0, remaining + ?) WHERE target_type = ? AND target_id = ?',
    [delta, targetType, targetId],
  )
}

export async function setMepRemaining(targetType: string, targetId: string, remaining: number): Promise<void> {
  const db = getDB()
  await db.run(
    'UPDATE mep_items SET remaining = MAX(0, ?) WHERE target_type = ? AND target_id = ?',
    [remaining, targetType, targetId],
  )
}

export async function insertMepLog(log: MepLog): Promise<void> {
  const db = getDB()
  await db.run(
    `INSERT INTO mep_logs (id, restaurant_id, branch_id, target_type, target_id, name, quantity, made_by, made_at, reversed, pending_undo, synced, sync_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [log.id, log.restaurant_id, log.branch_id, log.target_type, log.target_id, log.name, log.quantity, log.made_by, log.made_at, log.reversed, log.pending_undo, log.synced, log.sync_error],
  )
}

export async function getTodayMepLogs(branchId?: string | null): Promise<MepLog[]> {
  const db = getDB()
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const normalized = normalizeScopeId(branchId)
  const rows = normalized
    ? await db.query('SELECT * FROM mep_logs WHERE branch_id = ? AND made_at >= ? ORDER BY made_at DESC', [normalized, startOfDay.toISOString()])
    : await db.query('SELECT * FROM mep_logs WHERE made_at >= ? ORDER BY made_at DESC', [startOfDay.toISOString()])
  return (rows ?? []) as unknown as MepLog[]
}

export async function getUnsyncedMepLogs(): Promise<MepLog[]> {
  const db = getDB()
  const rows = await db.query('SELECT * FROM mep_logs WHERE synced = 0 AND reversed = 0 ORDER BY made_at ASC', [])
  return (rows ?? []) as unknown as MepLog[]
}

export async function getPendingMepUndos(): Promise<MepLog[]> {
  const db = getDB()
  const rows = await db.query('SELECT * FROM mep_logs WHERE pending_undo = 1 ORDER BY made_at ASC', [])
  return (rows ?? []) as unknown as MepLog[]
}

export async function markMepLogsSynced(ids: string[]): Promise<void> {
  if (!ids.length) return
  const db = getDB()
  for (const id of ids) {
    await db.run('UPDATE mep_logs SET synced = 1, sync_error = NULL WHERE id = ?', [id])
  }
}

export async function markMepLogReversed(id: string): Promise<void> {
  const db = getDB()
  await db.run('UPDATE mep_logs SET reversed = 1, pending_undo = 0, sync_error = NULL WHERE id = ?', [id])
}

export async function clearMepLogPendingUndo(id: string, error: string | null): Promise<void> {
  const db = getDB()
  await db.run('UPDATE mep_logs SET pending_undo = 0, sync_error = ? WHERE id = ?', [error, id])
}

export async function setMepLogPendingUndo(id: string): Promise<void> {
  const db = getDB()
  await db.run('UPDATE mep_logs SET pending_undo = 1 WHERE id = ?', [id])
}

export async function setMepLogSyncError(id: string, error: string | null): Promise<void> {
  const db = getDB()
  await db.run('UPDATE mep_logs SET sync_error = ? WHERE id = ?', [error, id])
}

// Hard server rejection (4xx): stop retrying — synced=1 keeps it out of the
// push queue, sync_error keeps the reason visible in the UI.
export async function markMepLogFailed(id: string, error: string): Promise<void> {
  const db = getDB()
  await db.run('UPDATE mep_logs SET synced = 1, sync_error = ? WHERE id = ?', [error, id])
}

// Marks server-known logs as synced (and reversed when the server says so),
// so a reinstalled device doesn't re-push logs the server already applied.
export async function reconcileMepLogs(remote: Array<{ client_log_id: string | null; reversed: number }>): Promise<void> {
  if (!remote.length) return
  const db = getDB()
  for (const log of remote) {
    if (!log.client_log_id) continue
    await db.run(
      'UPDATE mep_logs SET synced = 1, reversed = ?, sync_error = NULL WHERE id = ? AND pending_undo = 0',
      [log.reversed ? 1 : 0, log.client_log_id],
    )
  }
}

export async function getMepOutDishIds(branchId?: string | null): Promise<string[]> {
  const db = getDB()
  const normalized = normalizeScopeId(branchId)
  const rows = normalized
    ? await db.query("SELECT target_id FROM mep_items WHERE target_type = 'dish' AND remaining <= 0 AND branch_id = ?", [normalized])
    : await db.query("SELECT target_id FROM mep_items WHERE target_type = 'dish' AND remaining <= 0", [])
  return ((rows ?? []) as Array<{ target_id: string }>).map((row) => row.target_id)
}

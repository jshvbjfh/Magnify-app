import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite'

const sqlite = new SQLiteConnection(CapacitorSQLite)
let db: SQLiteDBConnection | null = null

const DB_NAME = 'magnify_waiter'
const DB_VERSION = 1

interface Migration {
  version: number
  sql: string
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
  // To add a migration, append a new entry here:
  // { version: 2, sql: 'ALTER TABLE orders ADD COLUMN kitchen_note TEXT;' },
]

export async function initDB(): Promise<void> {
  if (db) return

  const isConsistent = await sqlite.checkConnectionsConsistency()
  const isConn = (await sqlite.isConnection(DB_NAME, false)).result

  if (isConsistent.result && isConn) {
    db = await sqlite.retrieveConnection(DB_NAME, false)
  } else {
    db = await sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false)
  }

  await db.open()
  await runMigrations()
}

async function runMigrations(): Promise<void> {
  const d = getDB()

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
    await d.execute(migration.sql)
    await d.run(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      [migration.version, new Date().toISOString()],
    )
  }
}

function getDB(): SQLiteDBConnection {
  if (!db) throw new Error('DB not initialised — call initDB() first')
  return db
}

// ─── Session ────────────────────────────────────────────────────────────────

export async function setSession(key: string, value: string): Promise<void> {
  await getDB().run(
    'INSERT OR REPLACE INTO session (key, value) VALUES (?, ?)',
    [key, value]
  )
}

export async function getSession(key: string): Promise<string | null> {
  const res = await getDB().query('SELECT value FROM session WHERE key = ?', [key])
  return res.values?.[0]?.value ?? null
}

export async function clearSession(): Promise<void> {
  await getDB().run('DELETE FROM session')
}

// ─── App logs ───────────────────────────────────────────────────────────────

export interface AppLogEntry {
  id: string
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
  details: string | null
  created_at: string
}

export async function createLogEntry(entry: AppLogEntry): Promise<void> {
  await getDB().run(
    'INSERT OR REPLACE INTO app_logs (id, level, scope, message, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [entry.id, entry.level, entry.scope, entry.message, entry.details, entry.created_at]
  )
}

export async function getLogEntries(limit = 200): Promise<AppLogEntry[]> {
  const safeLimit = Math.max(1, Math.floor(limit))
  const res = await getDB().query(`SELECT * FROM app_logs ORDER BY created_at DESC LIMIT ${safeLimit}`)
  return (res.values ?? []) as AppLogEntry[]
}

export async function clearLogEntries(): Promise<void> {
  await getDB().run('DELETE FROM app_logs')
}

// ─── Config ─────────────────────────────────────────────────────────────────

export async function setConfig(key: string, value: string): Promise<void> {
  await getDB().run(
    'INSERT OR REPLACE INTO restaurant_config (key, value) VALUES (?, ?)',
    [key, value]
  )
}

export async function getConfig(key: string): Promise<string | null> {
  const res = await getDB().query('SELECT value FROM restaurant_config WHERE key = ?', [key])
  return res.values?.[0]?.value ?? null
}

// ─── Dishes ─────────────────────────────────────────────────────────────────

export interface Dish {
  id: string
  name: string
  selling_price: number
  category: string | null
  is_active: number
  branch_id: string | null
  restaurant_id: string | null
}

export async function replaceDishes(dishes: Dish[]): Promise<void> {
  if (!dishes.length) {
    // Guard: never wipe the local menu on an empty API response. An empty pull
    // almost certainly indicates a branchId mismatch or a transient server error,
    // not a legitimate empty menu. Preserve the existing rows so the waiter app
    // remains usable offline.
    console.warn('[replaceDishes] received empty dishes array — skipping replace to preserve local data')
    return
  }

  // F1-3: Branch-scoped delete instead of full table wipe.
  // All dishes in a single pull share one branch_id (mobile/pull L74 filters
  // by a single effectiveBranchId). Deleting only that branch's dishes preserves
  // other branches' menus for offline use when the waiter switches branches.
  const pullBranchId = dishes[0].branch_id
  const d = getDB()

  if (pullBranchId) {
    await d.executeSet([
      { statement: 'BEGIN', values: [] },
      { statement: 'DELETE FROM dishes WHERE branch_id = ?', values: [pullBranchId] },
      ...dishes.map(dish => ({
        statement: 'INSERT INTO dishes (id, name, selling_price, category, is_active, branch_id, restaurant_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        values: [dish.id, dish.name, dish.selling_price, dish.category, dish.is_active ? 1 : 0, dish.branch_id, dish.restaurant_id],
      })),
      { statement: 'COMMIT', values: [] },
    ])
  } else {
    // Fallback: if branch_id is null (legacy data), do a full replace
    await d.executeSet([
      { statement: 'BEGIN', values: [] },
      { statement: 'DELETE FROM dishes', values: [] },
      ...dishes.map(dish => ({
        statement: 'INSERT INTO dishes (id, name, selling_price, category, is_active, branch_id, restaurant_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        values: [dish.id, dish.name, dish.selling_price, dish.category, dish.is_active ? 1 : 0, dish.branch_id, dish.restaurant_id],
      })),
      { statement: 'COMMIT', values: [] },
    ])
  }
}

export async function getDishes(): Promise<Dish[]> {
  const res = await getDB().query('SELECT * FROM dishes WHERE is_active = 1 ORDER BY name')
  return (res.values ?? []) as Dish[]
}

// ─── Tables ─────────────────────────────────────────────────────────────────

export interface RestaurantTable {
  id: string
  name: string
  seats: number | null
  status: string
  branch_id: string | null
  restaurant_id: string | null
}

export async function replaceTables(tables: RestaurantTable[]): Promise<void> {
  if (!tables.length) {
    console.warn('[replaceTables] received empty tables array — skipping replace to preserve local data')
    return
  }
  // Branch-scoped: only wipe tables for the pulled branch so other branches
  // retain their cached floor plan when the waiter switches branches.
  const pullBranchId = tables[0].branch_id
  const d = getDB()
  if (pullBranchId) {
    await d.executeSet([
      { statement: 'BEGIN', values: [] },
      { statement: 'DELETE FROM restaurant_tables WHERE branch_id = ?', values: [pullBranchId] },
      ...tables.map(table => ({
        statement: 'INSERT INTO restaurant_tables (id, name, seats, status, branch_id, restaurant_id) VALUES (?, ?, ?, ?, ?, ?)',
        values: [table.id, table.name, table.seats, table.status ?? 'available', table.branch_id, table.restaurant_id],
      })),
      { statement: 'COMMIT', values: [] },
    ])
  } else {
    await d.executeSet([
      { statement: 'BEGIN', values: [] },
      { statement: 'DELETE FROM restaurant_tables', values: [] },
      ...tables.map(table => ({
        statement: 'INSERT INTO restaurant_tables (id, name, seats, status, branch_id, restaurant_id) VALUES (?, ?, ?, ?, ?, ?)',
        values: [table.id, table.name, table.seats, table.status ?? 'available', table.branch_id, table.restaurant_id],
      })),
      { statement: 'COMMIT', values: [] },
    ])
  }
}

export async function getTables(): Promise<RestaurantTable[]> {
  const res = await getDB().query('SELECT * FROM restaurant_tables ORDER BY name')
  return (res.values ?? []) as RestaurantTable[]
}

export async function updateTableStatus(tableId: string, status: string): Promise<void> {
  await getDB().run('UPDATE restaurant_tables SET status = ? WHERE id = ?', [status, tableId])
}

// ─── Orders ─────────────────────────────────────────────────────────────────

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
  synced: number
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
  created_at: string
  updated_at: string
}

export async function createOrder(order: Order, items: OrderItem[]): Promise<void> {
  const d = getDB()
  await d.run(
    `INSERT INTO orders
      (id, restaurant_id, branch_id, table_id, table_name, order_number, status,
       payment_method, subtotal_amount, vat_amount, total_amount, created_by_name,
       served_at, paid_at, canceled_at, cancel_reason, synced, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      order.id, order.restaurant_id, order.branch_id, order.table_id, order.table_name,
      order.order_number, order.status, order.payment_method, order.subtotal_amount,
      order.vat_amount, order.total_amount, order.created_by_name,
      order.served_at, order.paid_at, order.canceled_at, order.cancel_reason,
      order.created_at, order.updated_at,
    ]
  )
  for (const item of items) {
    await d.run(
      'INSERT INTO order_items (id, order_id, dish_id, dish_name, dish_price, qty, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [item.id, item.order_id, item.dish_id, item.dish_name, item.dish_price, item.qty, item.status, item.created_at, item.updated_at]
    )
  }
}

export async function updateOrder(
  orderId: string,
  fields: Partial<Pick<Order, 'status' | 'payment_method' | 'served_at' | 'paid_at' | 'canceled_at' | 'cancel_reason' | 'subtotal_amount' | 'vat_amount' | 'total_amount'>>
): Promise<void> {
  const now = new Date().toISOString()
  const entries = Object.entries({ ...fields, updated_at: now, synced: 0 })
  const setClauses = entries.map(([k]) => `${k} = ?`).join(', ')
  const values = entries.map(([, v]) => v)
  await getDB().run(`UPDATE orders SET ${setClauses} WHERE id = ?`, [...values, orderId])
}

export async function getOrders(filter?: { status?: string }): Promise<Order[]> {
  if (filter?.status) {
    const res = await getDB().query(
      'SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC',
      [filter.status]
    )
    return (res.values ?? []) as Order[]
  }
  const res = await getDB().query('SELECT * FROM orders ORDER BY created_at DESC')
  return (res.values ?? []) as Order[]
}

export async function getOrderItems(orderId: string): Promise<OrderItem[]> {
  const res = await getDB().query('SELECT * FROM order_items WHERE order_id = ?', [orderId])
  return (res.values ?? []) as OrderItem[]
}

export async function getUnsyncedOrders(): Promise<{ orders: Order[]; items: OrderItem[] }> {
  const ordersRes = await getDB().query('SELECT * FROM orders WHERE synced = 0')
  const orders = (ordersRes.values ?? []) as Order[]
  const items: OrderItem[] = []
  for (const order of orders) {
    const itemsRes = await getDB().query('SELECT * FROM order_items WHERE order_id = ?', [order.id])
    items.push(...((itemsRes.values ?? []) as OrderItem[]))
  }
  return { orders, items }
}

export async function markOrdersSynced(orders: Array<{ id: string; updated_at: string }>): Promise<void> {
  if (!orders.length) return
  for (const order of orders) {
    await getDB().run(
      'UPDATE orders SET synced = 1 WHERE id = ? AND updated_at = ?',
      [order.id, order.updated_at]
    )
  }
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
// for re-push (synced stays 1). Only updates rows where server updated_at is newer.
export async function reconcileOrderStatuses(remoteOrders: RemoteOrderStatus[]): Promise<void> {
  if (!remoteOrders.length) return
  const d = getDB()
  for (const remote of remoteOrders) {
    await d.run(
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
      ]
    )
  }
}

// ─── Cancellation Approvers ──────────────────────────────────────────────────
// Pulled from server on every pullSync. Only stores id, name, and bcrypt hash.
// No PINs in plaintext — validation is bcrypt.compare() locally when offline.

export interface CancellationApprover {
  id: string
  name: string
  pin_hash: string
}

export async function replaceCancellationApprovers(approvers: CancellationApprover[]): Promise<void> {
  const d = getDB()
  await d.executeSet([
    { statement: 'DELETE FROM cancellation_approvers', values: [] },
    ...approvers.map(a => ({
      statement: 'INSERT INTO cancellation_approvers (id, name, pin_hash) VALUES (?, ?, ?)',
      values: [a.id, a.name, a.pin_hash],
    })),
  ])
}

export async function getCancellationApprovers(): Promise<CancellationApprover[]> {
  const res = await getDB().query('SELECT * FROM cancellation_approvers ORDER BY name')
  return (res.values ?? []) as CancellationApprover[]
}

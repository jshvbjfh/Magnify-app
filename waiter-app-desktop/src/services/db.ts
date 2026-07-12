// Desktop IPC bridge for SQLite (better-sqlite3 in main process).
// Mirrors the Capacitor SQLite API surface used by the waiter-app but
// communicates via window.electronDB which is exposed by preload.js.
//
// Schema is identical to the Android waiter-app SQLite schema so that the
// same sync endpoints and page components work unchanged.

// ---- type helpers ----------------------------------------------------------

interface DBRow {
  [key: string]: unknown
}

type StatementSet = { statement: string; values: unknown[] }[]

// ---- bridge access ---------------------------------------------------------

function getDB() {
  const w = window as unknown as {
    electronDB?: {
      run: (sql: string, params?: unknown[]) => Promise<{ changes: number; lastInsertRowid: number | bigint }>
      query: (sql: string, params?: unknown[]) => Promise<DBRow[]>
      executeSet: (statements: StatementSet) => Promise<{ changes: number }>
    }
  }
  if (!w.electronDB) throw new Error('electronDB bridge not available')
  return w.electronDB
}

// ---- db init ---------------------------------------------------------------

export async function initDB(): Promise<void> {
  // Schema is created by main.js on startup. Health-check only.
  const db = getDB()
  await db.query('SELECT 1', [])
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
         served_at, paid_at, canceled_at, cancel_reason, synced, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      values: [
        order.id, order.restaurant_id, order.branch_id, order.table_id, order.table_name,
        order.order_number, order.status, order.payment_method, order.subtotal_amount,
        order.vat_amount, order.total_amount, order.created_by_name,
        order.served_at, order.paid_at, order.canceled_at, order.cancel_reason,
        order.created_at, order.updated_at,
      ],
    },
    ...items.map((item) => ({
      statement:
        'INSERT INTO order_items (id, order_id, dish_id, dish_name, dish_price, qty, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      values: [item.id, item.order_id, item.dish_id, item.dish_name, item.dish_price, item.qty, item.status, item.notes ?? null, item.created_at, item.updated_at],
    })),
  ]
  await db.executeSet(statements)
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
           served_at, paid_at, canceled_at, cancel_reason, synced, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?)`,
        values: [
          order.id, order.restaurant_id, order.branch_id, order.table_id, order.table_name,
          order.order_number, order.status, order.payment_method, order.subtotal_amount,
          order.vat_amount, order.total_amount, order.created_by_name,
          order.paid_at, order.canceled_at, order.cancel_reason,
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

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

// Which app this build is, stamped onto every order it creates. This is the
// one thing the two waiter apps must genuinely disagree about: the till can
// print and the Windows till cannot, so the pending list uses it to show a Push
// button only for orders whose tickets no printer has ever seen.
export const ORDER_SOURCE = 'desktop'

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
  // How many people sat at the table. Optional — null means the waiter skipped it.
  guest_count: number | null
  served_at: string | null
  paid_at: string | null
  canceled_at: string | null
  cancel_reason: string | null
  // Who closed the bill, when that was not simply the waiter who took it — a
  // supervisor settling another waiter's table. created_by_name is left alone,
  // so the sale stays credited to the waiter in every report.
  settled_by_name: string | null
  // 'No Charge' settlement: why nothing was charged (mandatory at the till),
  // and what the comp was worth at menu prices. The order's own totals are
  // zeroed on a comp, so comped_amount is the only record of the value.
  no_charge_reason: string | null
  comped_amount: number | null
  ar_customer_name: string | null
  ar_customer_phone: string | null
  shift_id: string | null
  business_date: string | null
  // Which app took the order: 'tablet' or 'desktop'. Null on orders taken
  // before this existed and on guest QR orders — read that as 'not a tablet'.
  source: string | null
  // Set when this order was joined into another. The row stays so the join is
  // auditable and an order number already quoted to a guest still resolves; its
  // status becomes MERGED and its items move to the survivor.
  merged_into_id: string | null
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
  // Per-line discount, 0-100, approved by a supervisor and printed on the bill.
  // Null means no discount — which is what every line taken before this existed
  // reads as, so no past bill changes value.
  discount_percent: number | null
  created_at: string
  updated_at: string
}

// What a line is actually worth after its discount. Mirrors
// calculateLineNetAmount on the server deliberately — the bill a guest is shown
// here and the journal entry raised there must agree to the franc, and both
// treat a percentage outside 0-100 as no discount at all.
export function lineNetAmount(item: { dish_price: number; qty: number; discount_percent?: number | null }): number {
  const gross = Number(item.dish_price) * Number(item.qty)
  if (!Number.isFinite(gross)) return 0
  const raw = Number(item.discount_percent)
  const pct = Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 0
  return gross * (1 - pct / 100)
}

export async function createOrder(order: Order, items: OrderItem[]): Promise<void> {
  const db = getDB()
  const statements: StatementSet = [
    {
      statement: `INSERT INTO orders
        (id, restaurant_id, branch_id, table_id, table_name, order_number, status,
         payment_method, subtotal_amount, vat_amount, total_amount, created_by_name,
         guest_count, served_at, paid_at, canceled_at, cancel_reason, shift_id, business_date, source, synced, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      values: [
        order.id, order.restaurant_id, order.branch_id, order.table_id, order.table_name,
        order.order_number, order.status, order.payment_method, order.subtotal_amount,
        order.vat_amount, order.total_amount, order.created_by_name,
        order.guest_count ?? null,
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

// Set or clear a line's discount. Marks the order unsynced so the next push
// carries the new price to the server, where the same percentage drives the
// journal entry and the dish sale — the till and the books must never disagree
// about what a line was worth.
//
// The caller is responsible for having taken a supervisor PIN first; this is
// only the write.
export async function setItemDiscount(orderId: string, itemId: string, percent: number | null): Promise<void> {
  const db = getDB()
  const now = new Date().toISOString()
  // Anything outside 0-100 is stored as no discount at all, matching
  // calculateLineNetAmount on the server. A bill must never grow because of a
  // discount, nor go below zero.
  const clean = percent !== null && Number.isFinite(percent) && percent > 0 && percent <= 100 ? percent : null
  await db.run('UPDATE order_items SET discount_percent = ?, updated_at = ? WHERE id = ?', [clean, now, itemId])
  await db.run('UPDATE orders SET updated_at = ?, synced = 0 WHERE id = ?', [now, orderId])
}

// Join orders: every source order's items move to the target, and each source
// row stays behind as MERGED pointing at the target.
//
// The rows are kept rather than deleted so the join is auditable and an order
// number a guest was already quoted still resolves to something. MERGED is
// outside both the active and the unsettled sets, so a merged order leaves the
// pending list, stops blocking an end-of-shift, and can never be paid a second
// time.
//
// Totals are deliberately NOT recomputed here: joining changes which bill the
// lines sit on, never what they cost. The target's totals are refreshed from
// its full item list by the caller, exactly as adding items to an order does.
export async function mergeOrdersLocal(targetId: string, sourceIds: string[]): Promise<void> {
  if (!sourceIds.length) return
  const db = getDB()
  const now = new Date().toISOString()
  const statements: StatementSet = []
  for (const sourceId of sourceIds) {
    if (sourceId === targetId) continue   // never absorb an order into itself
    statements.push({
      statement: 'UPDATE order_items SET order_id = ?, updated_at = ? WHERE order_id = ?',
      values: [targetId, now, sourceId],
    })
    statements.push({
      statement: 'UPDATE orders SET status = ?, merged_into_id = ?, updated_at = ?, synced = 0 WHERE id = ?',
      values: ['MERGED', targetId, now, sourceId],
    })
  }
  statements.push({
    statement: 'UPDATE orders SET updated_at = ?, synced = 0 WHERE id = ?',
    values: [now, targetId],
  })
  await db.executeSet(statements)
}

// Move ONE line off a bill and onto a new bill at another table.
//
// A guest orders at the counter, the whole round goes on one takeaway bill, and
// then the drinks are actually for table 6. Before this the only way out was to
// void the entire order and ring the whole thing again.
//
// Done as retire-and-recreate, not as an UPDATE of the line's order_id:
//
//  - the pulled copy of an order is INSERT OR IGNORE on every device, so a line
//    that merely changed hands would never move on any till but this one;
//  - the source line has to stay on its bill as CANCELED so the change is
//    visible rather than a line silently vanishing overnight;
//  - a CANCELED line is excluded from every total (locally by
//    recomputeOrderTotals, on the server by the push handler), so the money
//    lands on exactly one bill.
//
// One executeSet, so it is one transaction: a half-finished move would either
// charge the guest twice or not at all.
export async function moveOrderItemToNewOrder(params: {
  sourceOrderId: string
  sourceItemId: string
  newOrder: Order
  newItem: OrderItem
}): Promise<void> {
  const db = getDB()
  const now = new Date().toISOString()
  await db.executeSet([
    {
      statement: `INSERT INTO orders
        (id, restaurant_id, branch_id, table_id, table_name, order_number, status,
         payment_method, subtotal_amount, vat_amount, total_amount, created_by_name,
         guest_count, served_at, paid_at, canceled_at, cancel_reason, shift_id, business_date, source, synced, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      values: [
        params.newOrder.id, params.newOrder.restaurant_id, params.newOrder.branch_id,
        params.newOrder.table_id, params.newOrder.table_name, params.newOrder.order_number,
        params.newOrder.status, params.newOrder.payment_method,
        params.newOrder.subtotal_amount, params.newOrder.vat_amount, params.newOrder.total_amount,
        params.newOrder.created_by_name, params.newOrder.guest_count ?? null,
        params.newOrder.served_at, params.newOrder.paid_at, params.newOrder.canceled_at,
        params.newOrder.cancel_reason, params.newOrder.shift_id ?? null,
        params.newOrder.business_date ?? null, params.newOrder.source ?? null,
        params.newOrder.created_at, params.newOrder.updated_at,
      ],
    },
    {
      // The discount rides along: what the guest was promised must not change
      // because the line changed table.
      statement:
        'INSERT INTO order_items (id, order_id, dish_id, dish_name, dish_price, qty, status, notes, branch_id, discount_percent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      values: [
        params.newItem.id, params.newOrder.id, params.newItem.dish_id, params.newItem.dish_name,
        params.newItem.dish_price, params.newItem.qty, 'ACTIVE', params.newItem.notes ?? null,
        params.newItem.branch_id ?? null, params.newItem.discount_percent ?? null,
        params.newItem.created_at, now,
      ],
    },
    {
      statement: 'UPDATE order_items SET status = ?, updated_at = ? WHERE id = ?',
      values: ['CANCELED', now, params.sourceItemId],
    },
    {
      statement: 'UPDATE orders SET updated_at = ?, synced = 0 WHERE id = ?',
      values: [now, params.sourceOrderId],
    },
  ])
}

// Take one already-sent line off a bill.
//
// A guest changes their mind about one dish after it has gone to the kitchen.
// The supervisor's PIN is the control on it: they are expected to check with
// the kitchen that it has not been started before approving, which is why this
// records no waste and moves no stock. If it HAS been cooked, the right action
// is the manager portal's waste flow, not this.
//
// CANCELED rather than deleted, for the same reason a moved line is: the row
// has to survive to reach the server, and every total on both sides counts
// ACTIVE lines only.
export async function removeOrderItemLocal(orderId: string, itemId: string): Promise<void> {
  const db = getDB()
  const now = new Date().toISOString()
  await db.executeSet([
    { statement: 'UPDATE order_items SET status = ?, updated_at = ? WHERE id = ?', values: ['CANCELED', now, itemId] },
    { statement: 'UPDATE orders SET updated_at = ?, synced = 0 WHERE id = ?', values: [now, orderId] },
  ])
}

// Move a line onto a bill that is ALREADY open at the target table.
//
// A table with a bill open should end up with one bill, not two cards side by
// side — that was the whole complaint about the first version of this. Same
// retire-and-recreate shape as the new-bill case, and the same single
// transaction, because a half-finished move either charges twice or not at all.
export async function moveOrderItemToExistingOrder(params: {
  sourceOrderId: string
  sourceItemId: string
  targetOrderId: string
  newItem: OrderItem
}): Promise<void> {
  const db = getDB()
  const now = new Date().toISOString()
  await db.executeSet([
    {
      statement:
        'INSERT INTO order_items (id, order_id, dish_id, dish_name, dish_price, qty, status, notes, branch_id, discount_percent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      values: [
        params.newItem.id, params.targetOrderId, params.newItem.dish_id, params.newItem.dish_name,
        params.newItem.dish_price, params.newItem.qty, 'ACTIVE', params.newItem.notes ?? null,
        params.newItem.branch_id ?? null, params.newItem.discount_percent ?? null,
        params.newItem.created_at, now,
      ],
    },
    { statement: 'UPDATE order_items SET status = ?, updated_at = ? WHERE id = ?', values: ['CANCELED', now, params.sourceItemId] },
    { statement: 'UPDATE orders SET updated_at = ?, synced = 0 WHERE id = ?', values: [now, params.sourceOrderId] },
    { statement: 'UPDATE orders SET updated_at = ?, synced = 0 WHERE id = ?', values: [now, params.targetOrderId] },
  ])
}

// ---- item_moves ------------------------------------------------------------
// The record that makes a move reversible. Local only — the server sees a move
// as what it materially is, a retired line and a new one, and has no need to
// know it can be undone.

export interface ItemMove {
  id: string
  source_order_id: string
  source_order_number: string | null
  source_item_id: string
  target_order_id: string
  target_order_number: string | null
  target_item_id: string
  target_created: number
  // 1 when the move took the LAST line off the source bill, so that bill was
  // retired as MERGED. Undo has to revive it.
  source_emptied?: number
  table_name: string | null
  dish_name: string | null
  qty: number | null
  approved_by: string | null
  moved_at: string
  undone: number
}

// Retire a bill the move emptied.
//
// MERGED, not CANCELED: the money did not vanish, it went to another table, and
// MERGED is the status this app already uses for "absorbed into another order".
// It is outside both the active and the unsettled sets, so the bill leaves the
// pending list and stops blocking an end-of-shift, while the row stays for the
// audit and for undo to revive.
export async function retireEmptiedOrder(orderId: string, mergedIntoId: string): Promise<void> {
  const db = getDB()
  const now = new Date().toISOString()
  await db.run(
    'UPDATE orders SET status = ?, merged_into_id = ?, updated_at = ?, synced = 0 WHERE id = ?',
    ['MERGED', mergedIntoId, now, orderId],
  )
}

// How many lines are still live on a bill — used right after a move to decide
// whether anything is left on it at all.
export async function countActiveItems(orderId: string): Promise<number> {
  const db = getDB()
  const rows = await db.query(
    "SELECT COUNT(*) AS n FROM order_items WHERE order_id = ? AND COALESCE(status,'ACTIVE') = 'ACTIVE'",
    [orderId],
  )
  return Number((rows?.[0] as { n?: number } | undefined)?.n ?? 0)
}

export async function recordItemMove(move: Omit<ItemMove, 'undone'>): Promise<void> {
  const db = getDB()
  await db.run(
    `INSERT INTO item_moves
      (id, source_order_id, source_order_number, source_item_id, target_order_id, target_order_number,
       target_item_id, target_created, source_emptied, table_name, dish_name, qty, approved_by, moved_at, undone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      move.id, move.source_order_id, move.source_order_number, move.source_item_id,
      move.target_order_id, move.target_order_number, move.target_item_id, move.target_created,
      move.source_emptied ?? 0,
      move.table_name, move.dish_name, move.qty, move.approved_by, move.moved_at,
    ],
  )
}

// Moves that can still be taken back: not already undone, and both bills still
// open. A move onto a bill that has since been PAID is deliberately absent —
// putting the line back would change a bill the guest has already settled.
// The open bill on a table, read at the moment it is needed.
//
// Deliberately queried rather than taken from whatever the screen last loaded:
// the pending list in the page is a snapshot, and a bill opened on another till
// seconds ago is not in it. Moving a line against that snapshot is how a table
// ends up with two cards instead of one.
//
// PENDING only. An UNCONFIRMED guest QR order has not been accepted by anyone
// yet, so a line must not be absorbed into it — that order still has to be
// confirmed as a whole, and the moved line never needed confirming.
export async function findOpenOrderForTable(tableId: string): Promise<Order | null> {
  const db = getDB()
  const rows = await db.query(
    `SELECT * FROM orders
      WHERE table_id = ? AND status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT 1`,
    [tableId],
  )
  return ((rows ?? [])[0] as unknown as Order) ?? null
}

// The lines currently sitting on a bill because someone moved them there.
//
// Used to tint them in the pending list, so a waiter looking at a table can see
// at a glance which line did not start there. Screen only — the printed bill and
// the kitchen ticket say nothing about it, because the guest and the cook have
// no reason to care where a line was rung up first.
export async function getMovedItemIds(): Promise<Set<string>> {
  const db = getDB()
  const rows = await db.query('SELECT target_item_id FROM item_moves WHERE undone = 0', [])
  return new Set(((rows ?? []) as unknown as Array<{ target_item_id: string }>).map(r => r.target_item_id))
}

export async function getUndoableMoves(limit = 20): Promise<ItemMove[]> {
  const db = getDB()
  const rows = await db.query(
    `SELECT m.* FROM item_moves m
       JOIN orders src ON src.id = m.source_order_id
       JOIN orders tgt ON tgt.id = m.target_order_id
      WHERE m.undone = 0
        -- MERGED is allowed on the source, but ONLY when this move is the reason
        -- it is merged. A move that took the last line off a bill retires that
        -- bill, and excluding it here would make exactly those moves — the ones
        -- most worth taking back — impossible to undo.
        --
        -- The source_emptied test is what keeps that narrow. A bill can also
        -- reach MERGED through mergeOrdersLocal, when a waiter deliberately
        -- merges it into another. Undoing an older move against such a bill
        -- would put the line back onto an order the waiter can no longer see,
        -- because nothing revives it — the revive only runs for source_emptied.
        AND (
          src.status IN ('PENDING', 'UNCONFIRMED')
          OR (src.status = 'MERGED' AND m.source_emptied = 1)
        )
        AND tgt.status IN ('PENDING', 'UNCONFIRMED')
      ORDER BY m.moved_at DESC
      LIMIT ${Math.max(1, Math.floor(limit))}`,
    [],
  )
  return (rows ?? []) as unknown as ItemMove[]
}

// Put a moved line back where it came from.
//
// The reverse of the move, in one transaction: the original line goes back to
// ACTIVE, the copy is retired, and a bill that only existed to receive the line
// is cancelled with it. Both bills are marked unsynced so the correction
// reaches the server the same way the move did.
export async function undoItemMove(moveId: string): Promise<ItemMove> {
  const db = getDB()
  const rows = await db.query('SELECT * FROM item_moves WHERE id = ?', [moveId])
  const move = (rows ?? [])[0] as unknown as ItemMove | undefined
  if (!move) throw new Error('That move is no longer on record.')
  if (Number(move.undone) === 1) throw new Error('That move has already been undone.')

  // Re-check both bills at the moment of undoing, not when the list was drawn:
  // one of them may have been settled while the dialog sat open.
  const guard = await db.query(
    `SELECT id, status FROM orders WHERE id IN (?, ?)`,
    [move.source_order_id, move.target_order_id],
  )
  for (const row of (guard ?? []) as unknown as Array<{ id: string; status: string }>) {
    // MERGED counts as undoable on the source only when THIS move is why it is
    // merged — same reasoning as getUndoableMoves. A bill merged by the ordinary
    // merge flow carries source_emptied = 0, and reviving it is not this undo's
    // business: putting the line back there would hide it on an order the waiter
    // cannot see.
    const allowed = row.id === move.source_order_id && Number(move.source_emptied) === 1
      ? ['PENDING', 'UNCONFIRMED', 'MERGED']
      : ['PENDING', 'UNCONFIRMED']
    if (!allowed.includes(row.status)) {
      throw new Error('One of these bills has already been settled — the move cannot be undone.')
    }
  }

  const now = new Date().toISOString()
  const statements: StatementSet = [
    { statement: 'UPDATE order_items SET status = ?, updated_at = ? WHERE id = ?', values: ['ACTIVE', now, move.source_item_id] },
    { statement: 'UPDATE order_items SET status = ?, updated_at = ? WHERE id = ?', values: ['CANCELED', now, move.target_item_id] },
    { statement: 'UPDATE orders SET updated_at = ?, synced = 0 WHERE id = ?', values: [now, move.source_order_id] },
    { statement: 'UPDATE orders SET updated_at = ?, synced = 0 WHERE id = ?', values: [now, move.target_order_id] },
    { statement: 'UPDATE item_moves SET undone = 1 WHERE id = ?', values: [moveId] },
  ]
  if (Number(move.source_emptied) === 1) {
    // The bill was retired because this move emptied it. Putting the line back
    // has to bring the bill back too, or the line returns somewhere the waiter
    // can no longer see.
    statements.push({
      statement: 'UPDATE orders SET status = ?, merged_into_id = NULL, updated_at = ?, synced = 0 WHERE id = ?',
      values: ['PENDING', now, move.source_order_id],
    })
  }
  if (Number(move.target_created) === 1) {
    // This bill only ever existed to hold the moved line. Leaving it behind
    // empty would sit on the floor as a 0 RWF card and block an end-of-shift.
    statements.push({
      statement: 'UPDATE orders SET status = ?, cancel_reason = ?, canceled_at = ?, updated_at = ?, synced = 0 WHERE id = ?',
      values: ['CANCELED', 'Move undone', now, now, move.target_order_id],
    })
  }
  await db.executeSet(statements)
  return move
}

export async function getOrderById(orderId: string): Promise<Order | null> {
  const db = getDB()
  const rows = await db.query('SELECT * FROM orders WHERE id = ?', [orderId])
  return ((rows ?? [])[0] as unknown as Order) ?? null
}

export async function updateOrder(
  orderId: string,
  fields: Partial<Pick<Order, 'status' | 'payment_method' | 'served_at' | 'paid_at' | 'canceled_at' | 'cancel_reason' | 'subtotal_amount' | 'vat_amount' | 'total_amount' | 'created_by_name' | 'settled_by_name' | 'no_charge_reason' | 'comped_amount' | 'ar_customer_name' | 'ar_customer_phone'>>,
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

// The lines still ON this bill — ACTIVE only.
//
// A line that was moved to another table stays in the table as CANCELED,
// because that is the only way the change reaches the server. It is no longer
// part of this bill though, and returning it here is what made a move look like
// a copy: the dish appeared on the destination AND stayed on the original, with
// the original's total still counting it. Undo had the same symptom in reverse
// — the line stayed on the destination after being taken back.
//
// Every caller wants it this way: the pending cards, their totals, the printed
// bill, the payment slip and the edit-order cart.
//
// The push path deliberately does NOT come through here. getUnsyncedOrders
// reads order_items directly, because a cancellation only ever reaches the
// server by being sent to it.
//
// COALESCE, not `status = 'ACTIVE'`: rows written before the column had a
// default carry NULL, and those are live lines, not cancelled ones.
export async function getOrderItems(orderId: string): Promise<OrderItem[]> {
  const db = getDB()
  const rows = await db.query(
    "SELECT * FROM order_items WHERE order_id = ? AND COALESCE(status, 'ACTIVE') = 'ACTIVE'",
    [orderId],
  )
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
  dish_price: number; qty: number; status: string; notes?: string | null
  // Station that owns the line, and its discount — both come from the server.
  branch_id?: string | null; discount_percent?: number | null
  created_at: string; updated_at: string
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
        // branch_id and discount_percent come down with the line: the first
        // routes its kitchen ticket to the station that has to cook it, the
        // second is what the guest is actually charged. Dropping either here
        // would silently reprice or misroute a synced order.
        statement: `INSERT OR IGNORE INTO order_items
          (id, order_id, dish_id, dish_name, dish_price, qty, status, notes, branch_id, discount_percent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values: [item.id, item.order_id, item.dish_id, item.dish_name, item.dish_price, item.qty, item.status, item.notes ?? null, item.branch_id ?? null, item.discount_percent ?? null, item.created_at, item.updated_at],
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

// is_supervisor is SQLite's 0/1, not a boolean — read it through isSupervisor()
// rather than testing it for truthiness, or the string '0' a driver may hand
// back promotes every waiter to a supervisor.
export interface OrderCodeHolder extends CancellationApprover {
  is_supervisor?: number | boolean | string | null
}

export function isSupervisor(holder: Pick<OrderCodeHolder, 'is_supervisor'>): boolean {
  const flag = holder.is_supervisor
  return flag === 1 || flag === true || flag === '1'
}

export async function replaceOrderCodeHolders(holders: OrderCodeHolder[]): Promise<void> {
  const db = getDB()
  const statements: StatementSet = [
    { statement: 'DELETE FROM order_code_holders', values: [] },
    ...holders.map((h) => ({
      statement: 'INSERT INTO order_code_holders (id, name, pin_hash, is_supervisor) VALUES (?, ?, ?, ?)',
      values: [h.id, h.name, h.pin_hash, isSupervisor(h) ? 1 : 0],
    })),
  ]
  await db.executeSet(statements)
}

export async function getOrderCodeHolders(): Promise<OrderCodeHolder[]> {
  const db = getDB()
  const rows = await db.query('SELECT * FROM order_code_holders ORDER BY name', [])
  return (rows ?? []) as unknown as OrderCodeHolder[]
}

// ---- kitchen_tickets -------------------------------------------------------
// One row per slip fired at a station. The number on the paper (KOT #0006 /
// BOT #0002) restarts at 1 each business day per station, and is allocated
// HERE rather than on the server: a ticket has to print the instant the waiter
// fires it, internet or not.
//
// Rows are pushed up so the manager reads the same numbers the cooks are
// holding. Nothing reads them back down — the paper is already printed, so a
// server copy could only ever disagree with it.

export type KitchenTicketKind = 'KOT' | 'BOT'

export interface KitchenTicketRow {
  id: string
  order_id: string
  branch_id: string | null
  kind: string
  seq: number
  business_date: string
  printed_at: string
  synced: number
}

// Allocate the next slip number for one station on one business day, and record
// the slip in the same step. Returns the number to print.
//
// MAX(seq) + 1 rather than a stored counter: the count and the evidence are the
// same rows, so a half-written counter cannot drift away from the slips that
// actually printed, and clearing history resets the numbering by construction.
// COALESCE on branch_id because a line whose station cannot be resolved files
// under '' rather than vanishing from the day's numbering.
export async function recordKitchenTicket(params: {
  orderId: string
  branchId: string | null
  kind: KitchenTicketKind
  businessDate: string
}): Promise<number> {
  const db = getDB()
  const rows = await db.query(
    `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM kitchen_tickets
      WHERE COALESCE(branch_id, '') = COALESCE(?, '') AND business_date = ?`,
    [params.branchId, params.businessDate],
  )
  const seq = Number((rows?.[0] as { max_seq?: number } | undefined)?.max_seq ?? 0) + 1
  const now = new Date().toISOString()
  await db.run(
    `INSERT INTO kitchen_tickets (id, order_id, branch_id, kind, seq, business_date, printed_at, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      `kt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      params.orderId, params.branchId, params.kind, seq, params.businessDate, now,
    ],
  )
  return seq
}

export async function getUnsyncedKitchenTickets(): Promise<KitchenTicketRow[]> {
  const db = getDB()
  const rows = await db.query('SELECT * FROM kitchen_tickets WHERE synced = 0 ORDER BY printed_at', [])
  return (rows ?? []) as unknown as KitchenTicketRow[]
}

export async function markKitchenTicketsSynced(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = getDB()
  await db.run(
    `UPDATE kitchen_tickets SET synced = 1 WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  )
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

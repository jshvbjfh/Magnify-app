import bcrypt from 'bcryptjs'
import {
  replaceDishes, replaceTables, setConfig, getConfig,
  getDishes, getTables, getUnsyncedOrders, markOrdersSynced, updateOrderSyncError,
  replaceCancellationApprovers, getCancellationApprovers,
  replaceOrderCodeHolders, getOrderCodeHolders,
  reconcileOrderStatuses, upsertIncomingOrders, deleteServerRemovedOrders,
  replaceMepItems, replaceMepCatalog, reconcileMepLogs, adjustMepRemaining, setMepRemaining,
  getUnsyncedMepLogs, getPendingMepUndos, markMepLogsSynced, markMepLogReversed,
  markMepLogFailed, clearMepLogPendingUndo, setMepLogSyncError,
  upsertMepItem, deleteMepItem,
  getUnsyncedShifts, markShiftsSynced, upsertShiftFromServer, reconcileNoOpenShift,
  type Dish, type RestaurantTable, type CancellationApprover, type RemoteOrderStatus, type IncomingOrder,
  type MepItem, type MepCatalogEntry, type Shift,
} from './db'
import { getToken, invalidateSession, SESSION_INVALID_MESSAGE } from './auth'
import { API } from '../config'
import {
  getResponseHeader,
  responseDataToRecord,
  responseDataToText,
  sendRequest,
} from './http'
import { logError, logInfo, logWarn } from './logger'

// ─── Pull (Neon → SQLite) ────────────────────────────────────────────────────

export interface BranchInfo {
  id: string
  name: string
  code: string
  isMain: boolean
  type?: string
}

export interface MepPullSlice {
  items?: MepItem[]
  todayLogs?: Array<{ client_log_id: string | null; reversed: number }>
  preps?: MepCatalogEntry[]
}

export interface PullPayload {
  // True when the server had nothing new: the token this device sent still
  // matches, so no order data was sent at all and every field below is absent.
  // Nothing may be written to the local database on one of these — the arrays
  // are missing, not empty.
  unchanged?: boolean
  // The server's stamp of everything the order half can return. Echoed back as
  // ?since= on the next pull so an unchanged answer costs a few bytes instead
  // of the whole order set.
  changeToken?: string
  // The same, for the catalog half. Echoed back as ?catalogSince=.
  catalogToken?: string
  // True when the catalog was asked for and nothing in it had moved. The cached
  // menu stands, and — unlike a light pull — the catalog clock must be reset,
  // because the check genuinely happened.
  catalogUnchanged?: boolean
  // False when this was a light pull — the order half only. The catalog fields
  // below are then empty because they were not asked for, NOT because the
  // restaurant has no menu, and must be left alone rather than acted on.
  catalogIncluded?: boolean
  dishes: Dish[]
  tables: RestaurantTable[]
  restaurant: { id: string; name: string; billHeader?: string; billPrinterIp?: string | null; billPrinterPort?: number | null; shifts_enabled?: boolean }
  branches?: BranchInfo[]
  cancellationApprovers?: CancellationApprover[]
  openShift?: Shift | null
  mep?: MepPullSlice
}

export interface PullResult {
  warning?: string
}

function normalizeConfigId(value: string | null | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || undefined
}

async function requireValidToken(): Promise<string> {
  const token = await getToken()
  if (!token) {
    throw new Error(SESSION_INVALID_MESSAGE)
  }

  return token
}

// How often a device re-reads the catalog.
//
// One minute, not five. Almost the entire saving comes from splitting the pull
// at all, not from stretching the gap: at a 10-second poll the catalog costs
// twelve queries a minute at this interval and the average lands at ~5.3 per
// poll against 12 today — 56%. Going to five minutes would reach 64%, eight
// points more, for data five times staler.
//
// Those eight points are not worth it. Stock counts, prep lists and a dish
// being marked out all live in this half, so the interval is how long a waiter
// can keep selling something the kitchen has just run out of. A minute is
// invisible on the floor; five is a wrong order.
const CATALOG_PULL_INTERVAL_MS = 60 * 1000
// Zero, not Date.now(), so the first sync after launch always fetches the
// catalog — a device that has just started may have nothing cached at all.
let lastCatalogPullAt = 0

// The last stamp the server gave us, sent back as ?since= so an unchanged
// answer costs a few bytes rather than the whole order set. Null until the
// first pull of this launch, so a fresh process always takes a full one.
let lastChangeToken: string | null = null
// The same for the catalog half — the menu changes a few times a week, so this
// one nearly always still matches and saves the larger payload of the two.
let lastCatalogToken: string | null = null

// A full order pull happens at least this often even while the token insists
// nothing moved.
//
// The token mirrors each query exactly, so in normal running it is enough on
// its own. This is a floor under any drift we have not thought of — the price
// of the token being subtly wrong is a waiter looking at a stale floor, which
// is far worse than a little bandwidth, so it is worth paying for a backstop.
// Five minutes still leaves around 97% of polls answering cheaply.
const FULL_ORDER_PULL_INTERVAL_MS = 5 * 60 * 1000
let lastFullOrderPullAt = 0

export async function pullSync(branchId?: string): Promise<PullResult> {
  if (!API.pull) throw new Error('API base URL is not configured. Set VITE_API_BASE_URL in your build.')
  const token = await requireValidToken()
  const method = 'GET'

  const requestedBranchId = normalizeConfigId(branchId)
  const assignedBranchId = normalizeConfigId(await getConfig('branchId'))
  const activeBranchId = normalizeConfigId(await getConfig('activeBranchId'))
  const effectiveBranchId = requestedBranchId ?? activeBranchId ?? assignedBranchId
  // The menu, tables, staff, stations, MEP and stock change a few times a week;
  // orders change every minute. Pulling both every 10 seconds on every device is
  // what put the database under load — twelve queries a poll, almost all of it
  // re-reading rows nobody had touched. Ask for the catalog on the first sync
  // after launch, then every few minutes; the rest of the time take the orders
  // alone and leave the cached catalog in place.
  //
  // Always asked for when a branch is explicitly requested: switching station
  // changes the whole menu, and waiting minutes for it would be wrong.
  const wantCatalog = Boolean(requestedBranchId) || Date.now() - lastCatalogPullAt > CATALOG_PULL_INTERVAL_MS
  // Ask for the orders in full when the backstop is due, so no drift in the
  // token can outlive FULL_ORDER_PULL_INTERVAL_MS.
  const wantFullOrders = Date.now() - lastFullOrderPullAt > FULL_ORDER_PULL_INTERVAL_MS
  const params = new URLSearchParams()
  if (effectiveBranchId) params.set('branchId', effectiveBranchId)
  if (!wantCatalog) params.set('catalog', '0')
  // Only offer the order token when a cheap answer is actually allowed: never
  // when the full-order backstop is due.
  if (!wantFullOrders && lastChangeToken) params.set('since', lastChangeToken)
  // The catalog token only means anything on a pull that asks for the catalog.
  // A branch switch deliberately skips it: switching station changes the whole
  // menu and must never be answered from cache.
  if (wantCatalog && !requestedBranchId && lastCatalogToken) params.set('catalogSince', lastCatalogToken)
  const query = params.toString()
  const pullUrl = query ? `${API.pull}?${query}` : API.pull

  const response = await sendRequest({
    scope: 'sync',
    method,
    url: pullUrl,
    headers: { Authorization: `Bearer ${token}` },
  })

  if (response.status === 401) {
    const httpError = new Error(`HTTP ${response.status}`)

    await logWarn('sync', 'Pull sync unauthorized', {
      endpoint: pullUrl,
      method,
      status: response.status,
      error: httpError.message,
    })
    await invalidateSession('unauthorized')
    throw new Error(SESSION_INVALID_MESSAGE)
  }

  if (response.status < 200 || response.status >= 300) {
    const httpError = new Error(`HTTP ${response.status}`)

    await logError('sync', 'Pull sync failed', {
      endpoint: pullUrl,
      method,
      status: response.status,
      branchId: effectiveBranchId ?? null,
      error: httpError.message,
    })

    const rawBody = responseDataToText(response.data)
    const { body, parsedFromJson } = responseDataToRecord(response.data)

    if (!parsedFromJson && rawBody) {
      await logError('sync', 'Pull response was not JSON', {
        endpoint: pullUrl,
        method,
        status: response.status,
        contentType: getResponseHeader(response.headers, 'content-type'),
        preview: rawBody.slice(0, 240),
      })
    }

    const message = typeof body.error === 'string'
      ? body.error
      : `Pull failed: ${response.status}`

    throw new Error(message)
  }

  const rawBody = responseDataToText(response.data)
  const { body: payloadBody, parsedFromJson } = responseDataToRecord(response.data)

  if (!parsedFromJson) {
    await logError('sync', 'Pull response was not JSON', {
      endpoint: pullUrl,
      method,
      status: response.status,
      contentType: getResponseHeader(response.headers, 'content-type'),
      preview: rawBody.slice(0, 240),
    })
    throw new Error('Pull response was not JSON. Open startup.log for details.')
  }

  const payload = payloadBody as unknown as PullPayload

  // Nothing moved since the last pull, so the server sent no orders, no dishes
  // and no tables — because they were not asked for, not because they are gone.
  // Every write below has to be skipped: running them against a payload with no
  // arrays in it would clear the floor on a quiet afternoon. Returning here is
  // the whole saving.
  if (payload.unchanged === true) {
    if (payload.changeToken) lastChangeToken = payload.changeToken
    if (payload.catalogToken) lastCatalogToken = payload.catalogToken
    // The catalog was genuinely checked and had not moved, so its clock resets
    // exactly as if it had been fetched. Without this the next poll asks for it
    // again ten seconds later, and the check gets paid for on every single one.
    if (payload.catalogUnchanged) lastCatalogPullAt = Date.now()
    // Still a successful round trip, so the "last contacted the server" clock
    // moves. lastPulledAt deliberately does not: nothing was refreshed.
    await setConfig('lastPullAttemptAt', new Date().toISOString())
    return {}
  }

  // A pull that carried real order data — remember its stamps for next time and
  // reset the backstop clock.
  if (payload.changeToken) lastChangeToken = payload.changeToken
  if (payload.catalogToken) lastCatalogToken = payload.catalogToken
  if (payload.catalogUnchanged) lastCatalogPullAt = Date.now()
  lastFullOrderPullAt = Date.now()

  const currentRestaurantId = payload.restaurant?.id ?? null
  // Dishes are restaurant-wide (all branches); delete by restaurant only so the
  // full fresh set can be inserted without UNIQUE conflicts from stale branch rows.
  const dishReplaceScope = { restaurantId: currentRestaurantId }
  // Tables are now restaurant-wide (all branches shown at once), so delete/replace
  // by restaurant only — same approach as dishes.
  const replaceScope = { restaurantId: currentRestaurantId }

  // Only treat dishes/tables from THIS restaurant as a valid offline cache.
  // Data from a previous restaurant login is stale foreign data, not a fallback.
  const allDishes = await getDishes()
  const allTables = await getTables()
  const existingDishes = currentRestaurantId
    ? allDishes.filter(d => d.restaurant_id === currentRestaurantId)
    : allDishes
  const existingTables = currentRestaurantId
    ? allTables.filter(t => t.restaurant_id === currentRestaurantId)
    : allTables
  const warnings: string[] = []
  const now = new Date().toISOString()
  let didRefreshLocalSnapshot = false

  // A light pull carries no catalog, so none of the checks below apply: empty
  // here means "not asked for", not "this station has no menu". Acting on it
  // would warn the waiter their menu is gone, or throw outright.
  const hasCatalog = payload.catalogIncluded !== false

  if (hasCatalog && payload.dishes.length === 0) {
    // Don't wipe the local cache on an empty response — a transient server error
    // or misconfiguration could cause 0 dishes, and clearing would break offline use.
    if (existingDishes.length > 0) {
      warnings.push('This station currently has no menu. Showing your cached menu.')
    }
  } else if (hasCatalog) {
    await replaceDishes(payload.dishes, dishReplaceScope)
    didRefreshLocalSnapshot = true
    // Only a pull that actually carried the catalog resets the clock, so a
    // failed or light one does not postpone the next real refresh.
    lastCatalogPullAt = Date.now()
  }

  if (hasCatalog && payload.tables.length === 0) {
    // Same defensive approach for tables — preserve local cache on empty pull.
    if (existingTables.length > 0) {
      warnings.push('This station currently has no tables.')
    }
  } else if (hasCatalog) {
    await replaceTables(payload.tables, replaceScope)
    didRefreshLocalSnapshot = true
  }

  if (hasCatalog && payload.dishes.length === 0 && existingDishes.length === 0) {
    await logError('sync', 'Pull returned no menu for assigned branch', {
      restaurantId: payload.restaurant.id,
      branchId: effectiveBranchId ?? null,
      dishes: payload.dishes.length,
      tables: payload.tables.length,
    })
    throw new Error('No menu is available for your assigned station. Ask your manager to sync the station menu and verify your station assignment.')
  }

  await setConfig('restaurantName', payload.restaurant.name)
  // Manager-editable receipt template (top/bottom text); printed verbatim on bills.
  await setConfig('billHeader', payload.restaurant.billHeader ?? '')
  // Network thermal printer for ESC/POS bill printing (set in manager app → synced here).
  await setConfig('billPrinterIp', payload.restaurant.billPrinterIp ?? '')
  await setConfig('billPrinterPort', payload.restaurant.billPrinterPort != null ? String(payload.restaurant.billPrinterPort) : '')
  // Whether this venue runs service shifts. Absent on servers older than this
  // field, so treat only an explicit false as off — a missing value must keep
  // the shift gate up rather than silently unlock the till.
  await setConfig('shiftsEnabled', payload.restaurant.shifts_enabled === false ? '0' : '1')
  await setConfig('lastPullAttemptAt', now)
  if (didRefreshLocalSnapshot) {
    await setConfig('lastPulledAt', now)
  }

  // Store branch list so the UI can render branch chips without another network call.
  if (Array.isArray(payload.branches) && payload.branches.length > 0) {
    await setConfig('branches', JSON.stringify(payload.branches))
  }

  // Store cancellation approvers (5-digit supervisor PINs) for offline validation
  if (Array.isArray(payload.cancellationApprovers) && payload.cancellationApprovers.length > 0) {
    await replaceCancellationApprovers(payload.cancellationApprovers)
  }

  // Store order code holders (4-digit waiter codes) for offline order confirmation
  const orderCodeHolders = (payload as unknown as { orderCodeHolders?: CancellationApprover[] }).orderCodeHolders
  if (Array.isArray(orderCodeHolders) && orderCodeHolders.length > 0) {
    await replaceOrderCodeHolders(orderCodeHolders)
  }

  // Mirror the server's open shift so this terminal agrees on whether the venue
  // is open. If the server has one, upsert it (unless we hold unsynced local
  // changes for it). If it has none, close any synced-OPEN local shift — another
  // terminal ended it — while leaving our own just-opened, not-yet-pushed shift.
  const openShift = (payload as unknown as { openShift?: Shift | null }).openShift
  if (openShift && openShift.id) {
    await upsertShiftFromServer(openShift)
  } else if (payload.restaurant?.id) {
    await reconcileNoOpenShift(payload.restaurant.id)
  }

  // Reconcile local order statuses with server-authoritative values (last 3 days).
  // Only updates rows where server updated_at is newer — never sets synced = 0.
  const recentOrders = (payload as unknown as { recentOrders?: RemoteOrderStatus[] }).recentOrders
  if (Array.isArray(recentOrders) && recentOrders.length > 0) {
    await reconcileOrderStatuses(recentOrders)
  }

  // Pull full active orders from the server (e.g. QR/guest orders) and insert
  // any that don't exist locally so the waiter sees them in their order list.
  const incomingOrders = (payload as unknown as { incomingOrders?: IncomingOrder[] }).incomingOrders
  if (Array.isArray(incomingOrders) && incomingOrders.length > 0) {
    await upsertIncomingOrders(incomingOrders)
  }

  // incomingOrders is the server's COMPLETE active set — so any synced local
  // active order missing from it was hard-deleted upstream and must go here
  // too, or it lingers on the till forever. Skipped when the list may be
  // truncated (server caps it at 300) so truncation can't mass-delete.
  if (Array.isArray(incomingOrders) && incomingOrders.length < 300) {
    const removed = await deleteServerRemovedOrders(payload.restaurant.id, incomingOrders.map(o => o.id))
    if (removed > 0) {
      await logInfo('sync', 'Removed orders deleted on the server', { removed })
    }
  }

  // MEP: replace this station's list + prep catalog with the server-authoritative
  // snapshot, reconcile today's logs, then re-apply the deltas of local logs the
  // server hasn't seen yet so their optimistic "remaining" isn't wiped by the pull.
  // hasCatalog matters here more than anywhere: on a light pull payload.mep is
  // still an object, just an empty one, and replaceMepItems([]) would wipe the
  // station's whole prep list rather than leave it alone.
  if (hasCatalog && payload.mep && effectiveBranchId) {
    await replaceMepItems(Array.isArray(payload.mep.items) ? payload.mep.items : [], effectiveBranchId)
    await replaceMepCatalog(Array.isArray(payload.mep.preps) ? payload.mep.preps : [], effectiveBranchId)
    if (Array.isArray(payload.mep.todayLogs) && payload.mep.todayLogs.length > 0) {
      await reconcileMepLogs(payload.mep.todayLogs)
    }
    const unsyncedMepLogs = await getUnsyncedMepLogs()
    for (const log of unsyncedMepLogs) {
      if (!log.branch_id || log.branch_id === effectiveBranchId) {
        await adjustMepRemaining(log.target_type, log.target_id, log.quantity)
      }
    }
  }

  if (warnings.length > 0) {
    await logWarn('sync', 'Pull sync completed with warnings', {
      restaurantId: payload.restaurant.id,
      dishes: payload.dishes.length,
      tables: payload.tables.length,
      warnings,
    })
  }

  return warnings.length > 0
    ? { warning: warnings.join(' ') }
    : {}
}

// ─── Push (SQLite → Neon) ────────────────────────────────────────────────────

export async function pushSync(): Promise<number> {
  if (!API.push) throw new Error('API base URL is not configured. Set VITE_API_BASE_URL in your build.')
  const token = await requireValidToken()
  const method = 'POST'

  const { orders: allUnsynced, items: allItems } = await getUnsyncedOrders()
  const allUnsyncedShifts = await getUnsyncedShifts()

  // Only push rows that belong to the current session's restaurant. Rows from a
  // previous login (different restaurant) are silently skipped by the server and
  // would loop forever as unsynced without this guard.
  const sessionRestaurantId = (await getConfig('restaurantId'))?.trim() ?? ''
  const orders = sessionRestaurantId
    ? allUnsynced.filter(o => o.restaurant_id === sessionRestaurantId)
    : allUnsynced
  const shifts = sessionRestaurantId
    ? allUnsyncedShifts.filter(s => s.restaurant_id === sessionRestaurantId)
    : allUnsyncedShifts

  // Nothing to push (neither orders nor shifts) — done.
  if (!orders.length && !shifts.length) return 0

  const orderIds = new Set(orders.map(o => o.id))
  const items = allItems.filter(i => orderIds.has(i.order_id))

  const response = await sendRequest({
    scope: 'sync',
    method,
    url: API.push,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { orders, orderItems: items, shifts },
  })

  if (response.status === 401) {
    const httpError = new Error(`HTTP ${response.status}`)

    await logWarn('sync', 'Push sync unauthorized', {
      endpoint: API.push,
      method,
      status: response.status,
      pendingOrders: orders.length,
      error: httpError.message,
    })
    await invalidateSession('unauthorized')
    throw new Error(SESSION_INVALID_MESSAGE)
  }

  if (response.status < 200 || response.status >= 300) {
    const httpError = new Error(`HTTP ${response.status}`)

    await logError('sync', 'Push sync failed', {
      endpoint: API.push,
      method,
      status: response.status,
      pendingOrders: orders.length,
      pendingItems: items.length,
      error: httpError.message,
    })

    const rawBody = responseDataToText(response.data)
    const { body, parsedFromJson } = responseDataToRecord(response.data)

    if (!parsedFromJson && rawBody) {
      await logError('sync', 'Push response was not JSON', {
        endpoint: API.push,
        method,
        status: response.status,
        contentType: getResponseHeader(response.headers, 'content-type'),
        preview: rawBody.slice(0, 240),
      })
    }

    const message = typeof body.error === 'string'
      ? body.error
      : `Push failed: ${response.status}`

    throw new Error(message)
  }

  const rawBody = responseDataToText(response.data)
  const { body, parsedFromJson } = responseDataToRecord(response.data)

  if (!parsedFromJson) {
    await logError('sync', 'Push response was not JSON', {
      endpoint: API.push,
      method,
      status: response.status,
      contentType: getResponseHeader(response.headers, 'content-type'),
      preview: rawBody.slice(0, 240),
    })
    throw new Error('Push response was not JSON. Open startup.log for details.')
  }

  const { syncedOrderIds, syncedShiftIds, failedOrderIds, failedOrders } = body as {
    syncedOrderIds: string[]
    syncedShiftIds?: string[]
    failedOrderIds?: string[]
    failedOrders?: Array<{ orderId: string; error: string }>
  }
  const syncedOrders = orders.filter(o => syncedOrderIds.includes(o.id))
  await markOrdersSynced(syncedOrders)

  if (Array.isArray(syncedShiftIds) && syncedShiftIds.length > 0) {
    await markShiftsSynced(syncedShiftIds)
  }

  if (Array.isArray(failedOrders) && failedOrders.length > 0) {
    await Promise.all(
      failedOrders.map(f => updateOrderSyncError(f.orderId, f.error ?? 'Server rejected this order'))
    )
    await logWarn('sync', 'Push sync completed with failed orders', {
      pendingOrders: orders.length,
      pendingItems: items.length,
      syncedOrders: syncedOrderIds.length,
      failedOrders: failedOrderIds?.length ?? 0,
      failedOrderIds,
      failures: failedOrders,
    })
  }
  await logInfo('sync', 'Push sync completed', {
    pendingOrders: orders.length,
    pendingItems: items.length,
    syncedOrders: syncedOrderIds.length,
  })
  return syncedOrderIds.length
}

// ─── MEP push (SQLite → server) ──────────────────────────────────────────────
// Pushes queued "qty prepared" logs, then pending undos. The log id doubles as
// the server-side clientLogId, so replays after a lost response are idempotent.

export async function pushMepSync(): Promise<number> {
  if (!API.mep) return 0

  const [logs, undos] = await Promise.all([getUnsyncedMepLogs(), getPendingMepUndos()])
  if (!logs.length && !undos.length) return 0

  const token = await requireValidToken()
  let pushed = 0

  for (const log of logs) {
    try {
      const response = await sendRequest({
        scope: 'sync',
        method: 'POST',
        url: API.mep,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: {
          action: 'log',
          branchId: log.branch_id,
          targetType: log.target_type,
          targetId: log.target_id,
          quantity: log.quantity,
          clientLogId: log.id,
          madeBy: log.made_by,
          madeAt: log.made_at,
        },
      })

      if (response.status === 401) {
        await invalidateSession('unauthorized')
        throw new Error(SESSION_INVALID_MESSAGE)
      }

      const { body } = responseDataToRecord(response.data)
      if (response.status >= 200 && response.status < 300 && body.ok === true) {
        await markMepLogsSynced([log.id])
        if (typeof body.remaining === 'number') {
          await setMepRemaining(log.target_type, log.target_id, body.remaining)
        }
        pushed += 1
      } else if (response.status >= 400 && response.status < 500) {
        // Hard rejection (target deleted, bad payload) — never retry, keep the reason.
        const reason = typeof body.error === 'string' ? body.error : `Rejected (${response.status})`
        await markMepLogFailed(log.id, reason)
        await logWarn('sync', 'MEP log rejected by server', { logId: log.id, status: response.status, reason })
      } else {
        await setMepLogSyncErrorSafe(log.id, `Server error ${response.status}`)
      }
    } catch (err) {
      const message = (err as Error).message
      if (message === SESSION_INVALID_MESSAGE) throw err
      // Network failure — stay queued for the next cycle.
      await setMepLogSyncErrorSafe(log.id, message)
    }
  }

  for (const undo of undos) {
    try {
      const response = await sendRequest({
        scope: 'sync',
        method: 'POST',
        url: API.mep,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: { action: 'undo', branchId: undo.branch_id, clientLogId: undo.id },
      })

      if (response.status === 401) {
        await invalidateSession('unauthorized')
        throw new Error(SESSION_INVALID_MESSAGE)
      }

      const { body } = responseDataToRecord(response.data)
      if (response.status >= 200 && response.status < 300 && body.ok === true) {
        await markMepLogReversed(undo.id)
        if (typeof body.remaining === 'number') {
          await setMepRemaining(undo.target_type, undo.target_id, body.remaining)
        }
      } else if (response.status >= 200 && response.status < 300 && body.ok === false) {
        // Server refused (already consumed) — restore the optimistic subtraction.
        const reason = typeof body.reason === 'string' ? body.reason : 'Undo refused'
        await clearMepLogPendingUndo(undo.id, reason)
        await adjustMepRemaining(undo.target_type, undo.target_id, undo.quantity)
      } else if (response.status >= 400 && response.status < 500) {
        const reason = typeof body.error === 'string' ? body.error : `Rejected (${response.status})`
        await clearMepLogPendingUndo(undo.id, reason)
        await adjustMepRemaining(undo.target_type, undo.target_id, undo.quantity)
      }
      // 5xx / network: leave pending for the next cycle.
    } catch (err) {
      if ((err as Error).message === SESSION_INVALID_MESSAGE) throw err
    }
  }

  return pushed
}

async function setMepLogSyncErrorSafe(id: string, error: string) {
  try {
    await setMepLogSyncError(id, error)
  } catch {
    // Never let bookkeeping kill the sync loop.
  }
}

// ─── MEP list management (online-only) ───────────────────────────────────────
// Adding/removing MEP items is a rare curation action, so it requires the
// network — this avoids client/server id reconciliation for list rows.

export async function mepAddItemOnServer(params: {
  branchId: string | null
  targetType: 'prep' | 'dish'
  targetId: string
  addedBy?: string | null
}): Promise<MepItem> {
  if (!API.mep) throw new Error('API base URL is not configured.')
  const token = await requireValidToken()

  const response = await sendRequest({
    scope: 'sync',
    method: 'POST',
    url: API.mep,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: {
      action: 'add-item',
      branchId: params.branchId,
      targetType: params.targetType,
      targetId: params.targetId,
      addedBy: params.addedBy ?? null,
    },
  })

  if (response.status === 401) {
    await invalidateSession('unauthorized')
    throw new Error(SESSION_INVALID_MESSAGE)
  }

  const { body } = responseDataToRecord(response.data)
  if (response.status < 200 || response.status >= 300 || body.ok !== true) {
    throw new Error(typeof body.error === 'string' ? body.error : `Add failed: ${response.status}`)
  }

  const item = body.item as unknown as MepItem
  await upsertMepItem(item)
  return item
}

export async function mepRemoveItemOnServer(params: {
  branchId: string | null
  targetType: 'prep' | 'dish'
  targetId: string
  itemId: string
}): Promise<void> {
  if (!API.mep) throw new Error('API base URL is not configured.')
  const token = await requireValidToken()

  const response = await sendRequest({
    scope: 'sync',
    method: 'POST',
    url: API.mep,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: {
      action: 'remove-item',
      branchId: params.branchId,
      targetType: params.targetType,
      targetId: params.targetId,
    },
  })

  if (response.status === 401) {
    await invalidateSession('unauthorized')
    throw new Error(SESSION_INVALID_MESSAGE)
  }

  const { body } = responseDataToRecord(response.data)
  if (response.status < 200 || response.status >= 300 || body.ok !== true) {
    throw new Error(typeof body.error === 'string' ? body.error : `Remove failed: ${response.status}`)
  }

  await deleteMepItem(params.itemId)
}

// ─── Full sync cycle ─────────────────────────────────────────────────────────

export async function syncAll(branchId?: string): Promise<{ pushed: number; pulled: boolean; warning?: string; error?: string; authFailed?: boolean }> {
  let pushed = 0
  let pushError: string | undefined

  // Push and pull are independent — a push timeout must not block the pull.
  // QR menu orders live on the server and only reach the waiter via pull.
  try {
    pushed = await pushSync()
  } catch (err) {
    pushError = (err as Error).message
    // Auth failure means the token is invalid — pull would also fail, stop early.
    if (pushError === SESSION_INVALID_MESSAGE) {
      return { pushed: 0, pulled: false, error: pushError, authFailed: true }
    }
  }

  // MEP logs push before pull so the pull's server-authoritative "remaining"
  // already includes what this device just prepared.
  try {
    await pushMepSync()
  } catch (err) {
    const mepError = (err as Error).message
    if (mepError === SESSION_INVALID_MESSAGE) {
      return { pushed, pulled: false, error: mepError, authFailed: true }
    }
    pushError = pushError ?? mepError
  }

  try {
    const pullResult = await pullSync(branchId)
    return { pushed, pulled: true, warning: pullResult.warning, error: pushError }
  } catch (err) {
    const pullError = (err as Error).message
    return {
      pushed,
      pulled: false,
      error: pullError,
      authFailed: pullError === SESSION_INVALID_MESSAGE,
    }
  }
}

// ─── Offline PIN validation (fallback when server is unreachable) ────────────
// Uses the bcrypt hash cached from the last pullSync. Returns the approver name
// if valid, or throws with a user-visible message.

export async function validateCancellationPinOffline(pin: string): Promise<{ approvedBy: string }> {
  const approvers = await getCancellationApprovers()
  if (approvers.length === 0) {
    throw new Error('No supervisor PINs are cached. Connect to the internet and pull the menu first.')
  }
  for (const approver of approvers) {
    const match = await bcrypt.compare(pin, approver.pin_hash)
    if (match) return { approvedBy: approver.name }
  }
  throw new Error('Invalid supervisor PIN — ask a manager to enter their PIN')
}

export async function validateOrderCode(code: string): Promise<{ waiterName: string }> {
  const holders = await getOrderCodeHolders()
  if (holders.length === 0) {
    throw new Error('No order codes cached. Connect and sync first.')
  }
  for (const holder of holders) {
    const match = await bcrypt.compare(code, holder.pin_hash)
    if (match) return { waiterName: holder.name }
  }
  throw new Error('Invalid code — check your order code with your manager')
}

// ─── Cancel order with supervisor PIN (Neon validates PIN) ────────────────────────────────────────

export async function cancelOrderOnServer(params: {
  orderId: string
  supervisorPin: string
  cancelReason: string
}): Promise<{ approvedBy: string }> {
  if (!API.cancelOrder) throw new Error('API base URL is not configured.')
  const token = await requireValidToken()

  const response = await sendRequest({
    scope: 'cancel',
    method: 'POST',
    url: API.cancelOrder,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: {
      orderId:       params.orderId,
      supervisorPin: params.supervisorPin,
      cancelReason:  params.cancelReason,
    },
  })

  if (response.status === 401) {
    await invalidateSession('unauthorized')
    throw new Error(SESSION_INVALID_MESSAGE)
  }

  const { body } = responseDataToRecord(response.data)

  if (response.status === 403) {
    throw new Error(
      typeof body.error === 'string' ? body.error : 'Invalid supervisor PIN',
    )
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      typeof body.error === 'string' ? body.error : `Cancel failed: ${response.status}`,
    )
  }

  return { approvedBy: String(body.approvedBy ?? 'Supervisor') }
}

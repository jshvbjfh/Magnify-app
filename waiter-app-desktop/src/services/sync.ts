import bcrypt from 'bcryptjs'
import {
  replaceDishes, replaceTables, setConfig, getConfig,
  getDishes, getTables, getUnsyncedOrders, markOrdersSynced, updateOrderSyncError,
  replaceCancellationApprovers, getCancellationApprovers,
  replaceOrderCodeHolders, getOrderCodeHolders,
  reconcileOrderStatuses, upsertIncomingOrders,
  type Dish, type RestaurantTable, type CancellationApprover, type RemoteOrderStatus, type IncomingOrder,
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

export interface PullPayload {
  dishes: Dish[]
  tables: RestaurantTable[]
  restaurant: { id: string; name: string }
  branches?: BranchInfo[]
  cancellationApprovers?: CancellationApprover[]
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

export async function pullSync(branchId?: string): Promise<PullResult> {
  if (!API.pull) throw new Error('API base URL is not configured. Set WAITER_API_BASE_URL in runtime.env.')
  const token = await requireValidToken()
  const method = 'GET'

  const requestedBranchId = normalizeConfigId(branchId)
  const assignedBranchId = normalizeConfigId(await getConfig('branchId'))
  const activeBranchId = normalizeConfigId(await getConfig('activeBranchId'))
  const effectiveBranchId = requestedBranchId ?? activeBranchId ?? assignedBranchId
  const pullUrl = effectiveBranchId ? `${API.pull}?branchId=${encodeURIComponent(effectiveBranchId)}` : API.pull

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

  if (payload.dishes.length === 0) {
    // Don't wipe the local cache on an empty response — a transient server error
    // or misconfiguration could cause 0 dishes, and clearing would break offline use.
    if (existingDishes.length > 0) {
      warnings.push('This branch currently has no menu. Showing your cached menu.')
    }
  } else {
    await replaceDishes(payload.dishes, dishReplaceScope)
    didRefreshLocalSnapshot = true
  }

  if (payload.tables.length === 0) {
    // Same defensive approach for tables — preserve local cache on empty pull.
    if (existingTables.length > 0) {
      warnings.push('This branch currently has no tables.')
    }
  } else {
    await replaceTables(payload.tables, replaceScope)
    didRefreshLocalSnapshot = true
  }

  if (payload.dishes.length === 0 && existingDishes.length === 0) {
    await logError('sync', 'Pull returned no menu for assigned branch', {
      restaurantId: payload.restaurant.id,
      branchId: effectiveBranchId ?? null,
      dishes: payload.dishes.length,
      tables: payload.tables.length,
    })
    throw new Error('No menu is available for your assigned branch. Ask your manager to sync the branch menu and verify your branch assignment.')
  }

  await setConfig('restaurantName', payload.restaurant.name)
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
  if (!API.push) throw new Error('API base URL is not configured. Set WAITER_API_BASE_URL in runtime.env.')
  const token = await requireValidToken()
  const method = 'POST'

  const { orders: allUnsynced, items: allItems } = await getUnsyncedOrders()
  if (!allUnsynced.length) return 0

  // Only push orders that belong to the current session's restaurant.
  // Orders from a previous login (different restaurant) are silently skipped
  // by the server and would loop forever as unsynced without this guard.
  const sessionRestaurantId = (await getConfig('restaurantId'))?.trim() ?? ''
  const orders = sessionRestaurantId
    ? allUnsynced.filter(o => o.restaurant_id === sessionRestaurantId)
    : allUnsynced
  if (!orders.length) return 0
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
    data: { orders, orderItems: items },
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

  const { syncedOrderIds, failedOrderIds, failedOrders } = body as {
    syncedOrderIds: string[]
    failedOrderIds?: string[]
    failedOrders?: Array<{ orderId: string; error: string }>
  }
  const syncedOrders = orders.filter(o => syncedOrderIds.includes(o.id))
  await markOrdersSynced(syncedOrders)

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

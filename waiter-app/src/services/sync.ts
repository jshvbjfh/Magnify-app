import bcrypt from 'bcryptjs'
import {
  replaceDishes, replaceTables, setConfig, getConfig,
  getDishes, getTables, getUnsyncedOrders, markOrdersSynced,
  replaceCancellationApprovers, getCancellationApprovers,
  reconcileOrderStatuses,
  type Dish, type RestaurantTable, type CancellationApprover, type RemoteOrderStatus,
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

export interface PullPayload {
  dishes: Dish[]
  tables: RestaurantTable[]
  restaurant: { id: string; name: string }
  cancellationApprovers?: CancellationApprover[]
}

export interface PullResult {
  warning?: string
}

async function requireValidToken(): Promise<string> {
  const token = await getToken()
  if (!token) {
    throw new Error(SESSION_INVALID_MESSAGE)
  }

  return token
}

export async function pullSync(): Promise<PullResult> {
  const token = await requireValidToken()
  const method = 'GET'

  const response = await sendRequest({
    scope: 'sync',
    method,
    url: API.pull,
    headers: { Authorization: `Bearer ${token}` },
  })

  if (response.status === 401) {
    const httpError = new Error(`HTTP ${response.status}`)

    await logWarn('sync', 'Pull sync unauthorized', {
      endpoint: API.pull,
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
      endpoint: API.pull,
      method,
      status: response.status,
      error: httpError.message,
    })

    const rawBody = responseDataToText(response.data)
    const { body, parsedFromJson } = responseDataToRecord(response.data)

    if (!parsedFromJson && rawBody) {
      await logError('sync', 'Pull response was not JSON', {
        endpoint: API.pull,
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
      endpoint: API.pull,
      method,
      status: response.status,
      contentType: getResponseHeader(response.headers, 'content-type'),
      preview: rawBody.slice(0, 240),
    })
    throw new Error('Pull response was not JSON. Open startup.log for details.')
  }

  const payload = payloadBody as unknown as PullPayload
  const existingDishes = await getDishes()
  const existingTables = await getTables()
  const warnings: string[] = []
  const now = new Date().toISOString()
  let didRefreshLocalSnapshot = false

  if (payload.dishes.length === 0 && existingDishes.length === 0) {
    await logError('sync', 'Pull returned no menu for assigned branch', {
      restaurantId: payload.restaurant.id,
      dishes: payload.dishes.length,
      tables: payload.tables.length,
    })
    throw new Error('No menu is available for your assigned branch. Ask your manager to sync the branch menu and verify your branch assignment.')
  }

  if (payload.dishes.length === 0) {
    if (existingDishes.length > 0) {
      warnings.push('No menu received for this branch yet — using cached menu.')
    }
  } else {
    await replaceDishes(payload.dishes)
    didRefreshLocalSnapshot = true
  }

  if (payload.tables.length === 0) {
    if (existingTables.length > 0) {
      warnings.push('No tables received for this branch yet — using cached tables.')
    }
  } else {
    await replaceTables(payload.tables)
    didRefreshLocalSnapshot = true
  }

  await setConfig('restaurantName', payload.restaurant.name)
  await setConfig('lastPullAttemptAt', now)
  if (didRefreshLocalSnapshot) {
    await setConfig('lastPulledAt', now)
  }

  // Store cancellation approvers for offline PIN validation
  if (Array.isArray(payload.cancellationApprovers) && payload.cancellationApprovers.length > 0) {
    await replaceCancellationApprovers(payload.cancellationApprovers)
  }

  // Reconcile local order statuses with server-authoritative values (last 3 days).
  const recentOrders = (payload as unknown as { recentOrders?: RemoteOrderStatus[] }).recentOrders
  if (Array.isArray(recentOrders) && recentOrders.length > 0) {
    await reconcileOrderStatuses(recentOrders)
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
  if (Array.isArray(failedOrderIds) && failedOrderIds.length > 0) {
    await logWarn('sync', 'Push sync completed with failed orders', {
      pendingOrders: orders.length,
      pendingItems: items.length,
      syncedOrders: syncedOrderIds.length,
      failedOrders: failedOrderIds.length,
      failedOrderIds,
      failures: failedOrders ?? [],
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

export async function syncAll(): Promise<{ pushed: number; pulled: boolean; warning?: string; error?: string; authFailed?: boolean }> {
  let pushed = 0

  try {
    pushed = await pushSync()
    const pullResult = await pullSync()
    return { pushed, pulled: true, warning: pullResult.warning }
  } catch (err) {
    const error = (err as Error).message
    return {
      pushed,
      pulled: false,
      error,
      authFailed: error === SESSION_INVALID_MESSAGE,
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

export const RESTAURANT_OFFLINE_QUEUE_STORAGE_KEY = 'magnify.restaurantOfflineQueue.v1'
export const RESTAURANT_OFFLINE_QUEUE_CHANGED_EVENT = 'restaurantOfflineQueueChanged'

export type RestaurantOfflinePendingItem = {
  id: string
  orderId: string
  orderNumber: string
  tableId: string | null
  tableName: string
  dishId: string
  dishName: string
  dishPrice: number
  qty: number
  status?: string
  waiter?: { id?: string; name: string }
  addedAt?: string
  readyAt?: string | null
  orderServedAt?: string | null
  paymentMethod?: string | null
  totalAmount?: number
  notes?: string | null
}

export type RestaurantOfflineQueueProjection =
  | { type: 'append-pending-item'; item: RestaurantOfflinePendingItem }
  | { type: 'remove-pending-item'; itemId: string }
  | { type: 'mark-order-served'; orderId: string; servedAt: string }
  | { type: 'remove-order'; orderId: string }
  | { type: 'remove-started-order-items'; orderId: string }

export type RestaurantOfflineQueueEntry = {
  id: string
  kind: 'pending.create' | 'pending.delete' | 'order.serve' | 'order.pay' | 'order.cancel' | 'order.waste'
  label: string
  createdAt: string
  attempts: number
  lastError: string | null
  request: {
    url: string
    method: 'POST' | 'PATCH' | 'DELETE'
    body: Record<string, unknown>
  }
  projection: RestaurantOfflineQueueProjection
}

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function emitQueueChanged(entries: RestaurantOfflineQueueEntry[]) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(RESTAURANT_OFFLINE_QUEUE_CHANGED_EVENT, {
    detail: { count: entries.length },
  }))
}

function writeQueue(entries: RestaurantOfflineQueueEntry[]) {
  if (!canUseStorage()) return
  window.localStorage.setItem(RESTAURANT_OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(entries))
  emitQueueChanged(entries)
}

export function loadRestaurantOfflineQueue() {
  if (!canUseStorage()) return [] as RestaurantOfflineQueueEntry[]

  try {
    const raw = window.localStorage.getItem(RESTAURANT_OFFLINE_QUEUE_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as RestaurantOfflineQueueEntry[] : []
  } catch {
    return []
  }
}

export function saveRestaurantOfflineQueue(entries: RestaurantOfflineQueueEntry[]) {
  writeQueue(entries)
}

export function enqueueRestaurantOfflineQueue(entries: RestaurantOfflineQueueEntry | RestaurantOfflineQueueEntry[]) {
  const current = loadRestaurantOfflineQueue()
  const nextEntries = current.concat(entries)
  writeQueue(nextEntries)
  return nextEntries
}

export function updateRestaurantOfflineQueueEntry(entryId: string, updater: (entry: RestaurantOfflineQueueEntry) => RestaurantOfflineQueueEntry) {
  const nextEntries = loadRestaurantOfflineQueue().map((entry) => (entry.id === entryId ? updater(entry) : entry))
  writeQueue(nextEntries)
  return nextEntries
}

export function removeRestaurantOfflineQueueEntry(entryId: string) {
  const nextEntries = loadRestaurantOfflineQueue().filter((entry) => entry.id !== entryId)
  writeQueue(nextEntries)
  return nextEntries
}

export function removeRestaurantOfflineQueueEntries(predicate: (entry: RestaurantOfflineQueueEntry) => boolean) {
  const nextEntries = loadRestaurantOfflineQueue().filter((entry) => !predicate(entry))
  writeQueue(nextEntries)
  return nextEntries
}

export function projectRestaurantPendingItems<T extends RestaurantOfflinePendingItem>(items: T[], entries: RestaurantOfflineQueueEntry[]) {
  const projected = [...items] as RestaurantOfflinePendingItem[]

  for (const entry of [...entries].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())) {
    const projection = entry.projection

    switch (projection.type) {
      case 'append-pending-item': {
        if (!projected.some((item) => item.id === projection.item.id)) {
          projected.push(projection.item)
        }
        break
      }
      case 'remove-pending-item': {
        const nextItems = projected.filter((item) => item.id !== projection.itemId)
        projected.splice(0, projected.length, ...nextItems)
        break
      }
      case 'mark-order-served': {
        const nextItems = projected.map((item) => (
          item.orderId === projection.orderId
            ? { ...item, orderServedAt: projection.servedAt }
            : item
        ))
        projected.splice(0, projected.length, ...nextItems)
        break
      }
      case 'remove-order': {
        const nextItems = projected.filter((item) => item.orderId !== projection.orderId)
        projected.splice(0, projected.length, ...nextItems)
        break
      }
      case 'remove-started-order-items': {
        const nextItems = projected.filter((item) => {
          if (item.orderId !== projection.orderId) return true
          return !['in_kitchen', 'ready'].includes(String(item.status || ''))
        })
        projected.splice(0, projected.length, ...nextItems)
        break
      }
    }
  }

  return projected as T[]
}

export function isOfflineDraftOrderId(orderId: string | null | undefined) {
  return String(orderId || '').startsWith('offline-order-')
}

export function isLikelyOfflineError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase()
  return error instanceof TypeError || message.includes('failed to fetch') || message.includes('network')
}
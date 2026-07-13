// Persisted FIFO queue for stock entry saves.
//
// Every new stock entry becomes a "ticket" written to localStorage BEFORE the
// network request starts, so a crash or app close never loses an entry. The
// worker uploads tickets strictly one at a time; the server treats the ticket
// id as idempotent, so replaying a ticket that already committed is a no-op.
//
// Ticket lifecycle:
//   pending → uploading → (removed on success)
//                        ↘ retrying         network/server trouble — retries itself
//                        ↘ needs_attention  server rejected it — waits for the user

export type StockEntryTicketStatus = 'pending' | 'uploading' | 'retrying' | 'needs_attention'

export type StockEntryPayload = {
  batchId: string
  ingredientId?: string
  itemName: string
  unit: string
  purchaseUnit: string
  unitsPerPurchaseUnit: number
  supplier: string | null
  paymentMethod: string
  purchaseQuantity: number
  purchaseUnitCost: number
  purchasedAt: string
}

export type StockEntryTicket = {
  id: string
  restaurantId: string
  branchId: string | null
  createdAtIso: string
  status: StockEntryTicketStatus
  attempts: number
  lastError: string | null
  payload: StockEntryPayload
}

export type StockEntryConfirmation = {
  ticketId: string
  purchase: unknown
  ingredient: unknown
  alreadySaved: boolean
}

const STORAGE_KEY = 'magnify.stock-entry-queue.v1'
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000]

const ticketListeners = new Set<(tickets: StockEntryTicket[]) => void>()
const confirmationListeners = new Set<(confirmation: StockEntryConfirmation) => void>()

let activeRun: Promise<void> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let onlineListenerAttached = false

export function createStockEntryId() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`
  return `sp_${random}`
}

export function loadStockEntryTickets(): StockEntryTicket[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((ticket): ticket is StockEntryTicket =>
      Boolean(ticket && typeof ticket.id === 'string' && ticket.payload && typeof ticket.payload.itemName === 'string'))
  } catch {
    return []
  }
}

function persistTickets(tickets: StockEntryTicket[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tickets))
  } catch {
    // Quota/serialization failure: the in-memory queue still drains this session.
  }
}

function notifyTickets() {
  const tickets = loadStockEntryTickets()
  for (const listener of ticketListeners) listener(tickets)
}

function updateTicket(id: string, changes: Partial<StockEntryTicket>) {
  const tickets = loadStockEntryTickets()
  const index = tickets.findIndex((ticket) => ticket.id === id)
  if (index === -1) return
  tickets[index] = { ...tickets[index], ...changes }
  persistTickets(tickets)
  notifyTickets()
}

function removeTicket(id: string) {
  persistTickets(loadStockEntryTickets().filter((ticket) => ticket.id !== id))
  notifyTickets()
}

export function subscribeStockEntryTickets(listener: (tickets: StockEntryTicket[]) => void) {
  ticketListeners.add(listener)
  listener(loadStockEntryTickets())
  return () => { ticketListeners.delete(listener) }
}

export function subscribeStockEntryConfirmations(listener: (confirmation: StockEntryConfirmation) => void) {
  confirmationListeners.add(listener)
  return () => { confirmationListeners.delete(listener) }
}

export function enqueueStockEntry(ticket: Omit<StockEntryTicket, 'status' | 'attempts' | 'lastError' | 'createdAtIso'>) {
  const tickets = loadStockEntryTickets()
  tickets.push({ ...ticket, createdAtIso: new Date().toISOString(), status: 'pending', attempts: 0, lastError: null })
  persistTickets(tickets)
  notifyTickets()
  void processStockEntryQueue()
}

export function retryStockEntryTicket(id: string) {
  updateTicket(id, { status: 'pending', attempts: 0, lastError: null })
  void processStockEntryQueue()
}

export function discardStockEntryTicket(id: string) {
  removeTicket(id)
}

function scheduleRetry(attempts: number) {
  if (retryTimer) return
  const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)]
  retryTimer = setTimeout(() => {
    retryTimer = null
    void processStockEntryQueue()
  }, delay)
}

function attachOnlineListener() {
  if (onlineListenerAttached || typeof window === 'undefined') return
  onlineListenerAttached = true
  window.addEventListener('online', () => { void processStockEntryQueue() })
}

export function processStockEntryQueue(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (activeRun) {
    // A ticket enqueued mid-run could land after the loop's last queue read;
    // re-check once the current run finishes so it can't be stranded.
    return activeRun.then(() => (activeRun ? activeRun : startQueueRun()))
  }
  return startQueueRun()
}

function startQueueRun(): Promise<void> {
  activeRun = drainQueueOnce().finally(() => { activeRun = null })
  return activeRun
}

async function drainQueueOnce() {
  attachOnlineListener()
  try {
    // A ticket still marked "uploading" here is a leftover from a crashed or
    // closed session — the idempotent server id makes re-sending it safe.
    const stale = loadStockEntryTickets()
    if (stale.some((ticket) => ticket.status === 'uploading')) {
      persistTickets(stale.map((ticket) => ticket.status === 'uploading' ? { ...ticket, status: 'pending' as const } : ticket))
      notifyTickets()
    }

    for (;;) {
      const next = loadStockEntryTickets().find((ticket) => ticket.status !== 'needs_attention' && ticket.status !== 'uploading')
      if (!next) break

      updateTicket(next.id, { status: 'uploading' })

      let response: Response
      try {
        response = await fetch('/api/restaurant/inventory-purchases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ id: next.id, branchId: next.branchId ?? undefined, ...next.payload }),
        })
      } catch {
        updateTicket(next.id, { status: 'retrying', attempts: next.attempts + 1, lastError: 'No connection - will retry' })
        scheduleRetry(next.attempts)
        break
      }

      if (response.ok) {
        const data = await response.json().catch(() => null)
        removeTicket(next.id)
        const confirmation: StockEntryConfirmation = {
          ticketId: next.id,
          purchase: data?.purchase ?? null,
          ingredient: data?.ingredient ?? null,
          alreadySaved: Boolean(data?.alreadySaved),
        }
        for (const listener of confirmationListeners) listener(confirmation)
        continue
      }

      if (response.status === 401) {
        updateTicket(next.id, { status: 'retrying', attempts: next.attempts + 1, lastError: 'Signed out - sign in to finish saving' })
        scheduleRetry(next.attempts)
        break
      }

      if (response.status >= 500) {
        const body = await response.json().catch(() => null)
        updateTicket(next.id, { status: 'retrying', attempts: next.attempts + 1, lastError: body?.error || 'Server error - will retry' })
        scheduleRetry(next.attempts)
        break
      }

      // 4xx: the server rejected this entry — leave it visible and move on.
      const body = await response.json().catch(() => null)
      updateTicket(next.id, { status: 'needs_attention', lastError: body?.error || 'Save rejected' })
    }
  } catch {
    // Never let a queue bug take the UI down; the next kick re-reads storage.
  }
}

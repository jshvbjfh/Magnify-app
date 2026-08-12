import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStockEntryId,
  enqueueStockEntry,
  loadStockEntryTickets,
  processStockEntryQueue,
  subscribeStockEntryConfirmations,
  type StockEntryPayload,
} from '@/components/restaurant/stockEntryQueue'

const STORAGE_KEY = 'magnify.stock-entry-queue.v1'

function createMemoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
  }
}

const storage = createMemoryStorage()
const fetchMock = vi.fn()

function makePayload(overrides: Partial<StockEntryPayload> = {}): StockEntryPayload {
  return {
    batchId: 'BAT-20260713-A',
    itemName: 'Cooking Oil',
    unit: 'L',
    purchaseUnit: 'L',
    unitsPerPurchaseUnit: 1,
    supplier: null,
    paymentMethod: 'Cash',
    purchaseQuantity: 20,
    purchaseUnitCost: 100,
    purchasedAt: '2026-07-13',
    expiresAt: null,
    ...overrides,
  }
}

function makeTicket(payload: Partial<StockEntryPayload> = {}) {
  return {
    id: createStockEntryId(),
    restaurantId: 'rest-1',
    branchId: 'branch-main',
    payload: makePayload(payload),
  }
}

function okResponse(body: unknown = { purchase: { id: 'p1' }, ingredient: { id: 'ing-1' } }) {
  return { ok: true, status: 201, json: async () => body } as Response
}

function errorResponse(status: number, body: unknown = { error: 'Save rejected' }) {
  return { ok: false, status, json: async () => body } as Response
}

async function drainQueue() {
  // processStockEntryQueue resolves when the queue is empty or blocked.
  await processStockEntryQueue()
}

beforeEach(() => {
  storage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('window', {
    localStorage: storage,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  // Never leave tickets behind: a scheduled retry from one test must not leak
  // into the next. Drain with a success response, then advance any timers.
  fetchMock.mockResolvedValue(okResponse())
  vi.useFakeTimers()
  await drainQueue()
  await vi.runAllTimersAsync()
  vi.useRealTimers()
  storage.clear()
  vi.unstubAllGlobals()
})

describe('stockEntryQueue', () => {
  it('persists the ticket to storage before the upload finishes (write-ahead)', async () => {
    let releaseFetch: (value: Response) => void = () => {}
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { releaseFetch = resolve }))

    const ticket = makeTicket()
    enqueueStockEntry(ticket)

    const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]')
    expect(persisted).toHaveLength(1)
    expect(persisted[0].id).toBe(ticket.id)

    releaseFetch(okResponse())
    await drainQueue()
  })

  it('removes the ticket and notifies confirmation on success', async () => {
    fetchMock.mockResolvedValue(okResponse({ purchase: { id: 'p-9' }, ingredient: { id: 'ing-9' } }))
    const confirmations: unknown[] = []
    const unsubscribe = subscribeStockEntryConfirmations((confirmation) => { confirmations.push(confirmation) })

    enqueueStockEntry(makeTicket())
    await drainQueue()

    expect(loadStockEntryTickets()).toHaveLength(0)
    expect(confirmations).toHaveLength(1)
    expect((confirmations[0] as { purchase: { id: string } }).purchase.id).toBe('p-9')
    unsubscribe()
  })

  it('uploads strictly one at a time, in FIFO order', async () => {
    const sendOrder: string[] = []
    let inFlight = 0
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      inFlight += 1
      expect(inFlight).toBe(1)
      const body = JSON.parse(String(init.body))
      sendOrder.push(body.itemName)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return okResponse()
    })

    enqueueStockEntry(makeTicket({ itemName: 'First' }))
    enqueueStockEntry(makeTicket({ itemName: 'Second' }))
    enqueueStockEntry(makeTicket({ itemName: 'Third' }))
    await drainQueue()

    expect(sendOrder).toEqual(['First', 'Second', 'Third'])
    expect(loadStockEntryTickets()).toHaveLength(0)
  })

  it('marks a rejected entry needs_attention with the server reason and keeps going', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(400, { error: 'unit is required when recording a new item' }))
      .mockResolvedValue(okResponse())

    enqueueStockEntry(makeTicket({ itemName: 'Bad Entry' }))
    enqueueStockEntry(makeTicket({ itemName: 'Good Entry' }))
    await drainQueue()

    const tickets = loadStockEntryTickets()
    expect(tickets).toHaveLength(1)
    expect(tickets[0].status).toBe('needs_attention')
    expect(tickets[0].lastError).toBe('unit is required when recording a new item')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries automatically after a network failure without losing the ticket', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(okResponse())

    enqueueStockEntry(makeTicket())
    // Flush only microtasks: the enqueue-kicked run fails and schedules a retry.
    await vi.advanceTimersByTimeAsync(0)

    let tickets = loadStockEntryTickets()
    expect(tickets).toHaveLength(1)
    expect(tickets[0].status).toBe('retrying')
    expect(tickets[0].lastError).toContain('No connection')

    await vi.advanceTimersByTimeAsync(2_000)

    tickets = loadStockEntryTickets()
    expect(tickets).toHaveLength(0)
    vi.useRealTimers()
  })

  it('resumes a ticket left mid-upload by a crashed session', async () => {
    storage.setItem(STORAGE_KEY, JSON.stringify([{
      id: createStockEntryId(),
      restaurantId: 'rest-1',
      branchId: 'branch-main',
      createdAtIso: new Date().toISOString(),
      status: 'uploading',
      attempts: 0,
      lastError: null,
      payload: makePayload(),
    }]))
    fetchMock.mockResolvedValue(okResponse())

    await drainQueue()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(loadStockEntryTickets()).toHaveLength(0)
  })

  it('sends the ticket id and stamped branch to the server', async () => {
    fetchMock.mockResolvedValue(okResponse())
    const ticket = makeTicket()

    enqueueStockEntry(ticket)
    await drainQueue()

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.id).toBe(ticket.id)
    expect(body.branchId).toBe('branch-main')
    expect(body.itemName).toBe('Cooking Oil')
  })
})

// A discount taken on a whole bill rather than one line.
//
// It is stored as the same per-line percentage every other path already reads,
// so what these tests guard is that the bulk write cannot say something the
// single-line write would not: the same clamp, the same "unsynced" flag, and
// nothing written to a line that no total counts. A bill discount that reached
// a CANCELED line, or that left the order marked synced, would quote the guest
// one figure and book another.

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Statement = { statement: string; values: unknown[] }

const runMock = vi.fn()
const queryMock = vi.fn()
const executeSetMock = vi.fn<[Statement[]], Promise<{ changes: number }>>()

const { setItemDiscount, setOrderDiscount } = await import('../db')

beforeEach(() => {
  runMock.mockReset().mockResolvedValue({ changes: 1, lastInsertRowid: 1 })
  queryMock.mockReset().mockResolvedValue([])
  executeSetMock.mockReset().mockResolvedValue({ changes: 1 })
  ;(globalThis as unknown as { window: unknown }).window = {
    electronDB: { run: runMock, query: queryMock, executeSet: executeSetMock },
  }
})

const lastSet = (): Statement[] => executeSetMock.mock.calls.at(-1)![0]

// The percentage the bill write actually stored, whatever was asked for.
async function stored(percent: number | null): Promise<unknown> {
  await setOrderDiscount('order-1', percent)
  return lastSet()[0].values[0]
}

describe('setOrderDiscount', () => {
  it('writes the percentage to the bill in one transaction', async () => {
    await setOrderDiscount('order-1', 20)
    expect(executeSetMock).toHaveBeenCalledTimes(1)
    const [items, order] = lastSet()
    expect(items.statement).toContain('UPDATE order_items')
    expect(items.values[0]).toBe(20)
    expect(items.values[2]).toBe('order-1')
    expect(order.statement).toContain('UPDATE orders')
  })

  // A canceled line is worth nothing on any total and repricing it would
  // rewrite what a void said it cost.
  it('touches only the lines a total counts', async () => {
    await setOrderDiscount('order-1', 20)
    const items = lastSet()[0]
    expect(items.statement).toContain('status = ?')
    expect(items.values).toContain('ACTIVE')
  })

  // Without this the discount sits on this till only and the server keeps
  // billing, and booking, the undiscounted figure.
  it('leaves the order unsynced so the new price is pushed', async () => {
    await setOrderDiscount('order-1', 20)
    expect(lastSet()[1].statement).toContain('synced = 0')
  })

  it('clears every discount on the bill when given nothing', async () => {
    expect(await stored(null)).toBeNull()
    expect(await stored(0)).toBeNull()
  })

  // Same clamp as setItemDiscount and as the server: a bill must never grow
  // because of a discount, nor go below zero.
  it('refuses a percentage that would move money the wrong way', async () => {
    expect(await stored(150)).toBeNull()
    expect(await stored(-20)).toBeNull()
    expect(await stored(Number.NaN)).toBeNull()
    expect(await stored(Infinity)).toBeNull()
  })

  it('accepts the edges of the range', async () => {
    expect(await stored(0.5)).toBe(0.5)
    expect(await stored(100)).toBe(100)
  })

  // Both writes answer the same question — what is this line worth — so a
  // percentage one of them keeps and the other drops would mean a bill
  // discount and a line discount disagreeing about the same guest.
  it('stores what setItemDiscount would store', async () => {
    for (const pct of [20, 100, 0.5, 0, -5, 150, null]) {
      runMock.mockClear()
      await setItemDiscount('order-1', 'item-1', pct)
      const perLine = runMock.mock.calls[0][1][0]
      expect(await stored(pct)).toBe(perLine)
    }
  })
})

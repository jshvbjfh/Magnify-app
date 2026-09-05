/**
 * The cash drawer (§7.12), and the opening deposit the daily report needs
 * (§18.1.12).
 *
 * Cash figures fail quietly — a sign error or a swallowed row looks like theft
 * rather than a bug. Most of what is pinned here is that failure mode.
 */

import { describe, expect, it } from 'vitest'

import {
  CASH_MOVEMENT_KINDS,
  cashVariance,
  requiresApproval,
  summarizeCashDrawer,
} from '@/lib/cashDrawer'

const { OPENING_FLOAT, DEPOSIT, WITHDRAWAL } = CASH_MOVEMENT_KINDS

describe('a normal service', () => {
  const drawer = summarizeCashDrawer({
    movements: [
      { kind: OPENING_FLOAT, amount: 50000 },
      { kind: DEPOSIT, amount: 20000 },
      { kind: WITHDRAWAL, amount: 15000 },
    ],
    cashSales: 180000,
    cashRefunds: 5000,
  })

  it('separates the three kinds', () => {
    expect(drawer.openingFloat).toBe(50000)
    expect(drawer.deposits).toBe(20000)
    expect(drawer.withdrawals).toBe(15000)
  })

  it('works out what should be in the drawer', () => {
    // 50,000 float + 20,000 in + 180,000 taken − 15,000 out − 5,000 refunded
    expect(drawer.expectedInDrawer).toBe(230000)
  })
})

describe('direction is the kind, never the sign', () => {
  it('treats a negative withdrawal as a withdrawal, not a deposit', () => {
    // Someone types -15000 meaning "take out". Reading the sign would ADD it.
    const drawer = summarizeCashDrawer({ movements: [{ kind: WITHDRAWAL, amount: -15000 }] })

    expect(drawer.withdrawals).toBe(15000)
    expect(drawer.expectedInDrawer).toBe(-15000)
  })

  it('treats a negative deposit as a deposit', () => {
    const drawer = summarizeCashDrawer({ movements: [{ kind: DEPOSIT, amount: -500 }] })

    expect(drawer.deposits).toBe(500)
    expect(drawer.expectedInDrawer).toBe(500)
  })

  it('ignores an amount that is not a number rather than poisoning the total', () => {
    const drawer = summarizeCashDrawer({
      movements: [
        { kind: OPENING_FLOAT, amount: 10000 },
        { kind: DEPOSIT, amount: Number.NaN },
      ],
    })

    expect(drawer.expectedInDrawer).toBe(10000)
    expect(Number.isFinite(drawer.expectedInDrawer)).toBe(true)
  })
})

describe('an unrecognised kind is surfaced, not swallowed', () => {
  it('reports it instead of dropping the money silently', () => {
    const drawer = summarizeCashDrawer({
      movements: [
        { kind: OPENING_FLOAT, amount: 50000 },
        { kind: 'PAYOUT', amount: 9000 },
      ],
    })

    // It must not vanish into the total unnoticed — a cash figure that is
    // quietly wrong is worse than one that is loudly wrong.
    expect(drawer.unrecognised).toHaveLength(1)
    expect(drawer.unrecognised[0].kind).toBe('PAYOUT')
    expect(drawer.expectedInDrawer).toBe(50000)
  })

  it('accepts any casing or padding of a real kind', () => {
    const drawer = summarizeCashDrawer({
      movements: [
        { kind: ' opening_float ', amount: 1000 },
        { kind: 'Withdrawal', amount: 400 },
      ],
    })

    expect(drawer.unrecognised).toHaveLength(0)
    expect(drawer.expectedInDrawer).toBe(600)
  })
})

describe('the opening float', () => {
  it('sums corrections rather than taking the first', () => {
    // A float counted wrong is fixed by adding the difference, so both rows
    // count. Taking only the first would report the wrong opening deposit.
    const drawer = summarizeCashDrawer({
      movements: [
        { kind: OPENING_FLOAT, amount: 50000 },
        { kind: OPENING_FLOAT, amount: 5000 },
      ],
    })

    expect(drawer.openingFloat).toBe(55000)
  })

  it('is zero when nobody counted one in', () => {
    expect(summarizeCashDrawer({ movements: [] }).openingFloat).toBe(0)
  })
})

describe('only cash reaches the drawer', () => {
  it('counts nothing when no cash was taken', () => {
    // A night on card and mobile money only. Including those would make the
    // expected figure wrong by exactly the card total, and look like theft.
    const drawer = summarizeCashDrawer({
      movements: [{ kind: OPENING_FLOAT, amount: 50000 }],
      cashSales: 0,
    })

    expect(drawer.expectedInDrawer).toBe(50000)
  })
})

describe('approval', () => {
  it('is needed to take money out, and only that', () => {
    expect(requiresApproval(WITHDRAWAL)).toBe(true)
    expect(requiresApproval(DEPOSIT)).toBe(false)
    expect(requiresApproval(OPENING_FLOAT)).toBe(false)
    expect(requiresApproval('withdrawal')).toBe(true)
  })
})

describe('variance at close', () => {
  it('is positive when over and negative when short', () => {
    expect(cashVariance(230500, 230000)).toBe(500)
    expect(cashVariance(229000, 230000)).toBe(-1000)
    expect(cashVariance(230000, 230000)).toBe(0)
  })
})

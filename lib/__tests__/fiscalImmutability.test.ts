/**
 * Settled bills are final under fiscal mode.
 *
 * The two properties that matter: a settled bill cannot be voided when fiscal
 * mode is on, and NOTHING changes when it is off. The second is what protects
 * every venue currently trading on this code.
 */

import { describe, expect, it } from 'vitest'

import { canVoidSettledOrder, describeFiscalVoidRefusal, isSettledOrderStatus } from '@/lib/fiscalImmutability'

describe('fiscal mode on', () => {
  it('refuses to cancel a settled bill', () => {
    expect(canVoidSettledOrder({ fiscalMode: true, status: 'PAID', action: 'cancel' })).toBe(false)
    expect(describeFiscalVoidRefusal({ fiscalMode: true, status: 'PAID', action: 'cancel' }))
      .toBe("Settled bills can't be canceled — issue a refund instead")
  })

  it('refuses to delete a settled bill', () => {
    expect(canVoidSettledOrder({ fiscalMode: true, status: 'PAID', action: 'delete' })).toBe(false)
  })

  it('still allows voiding a bill nobody has paid', () => {
    // Correcting an open table is normal service, not a fiscal event — the sale
    // was never declared, so there is nothing to contradict.
    for (const status of ['PENDING', 'OPEN', 'UNCONFIRMED']) {
      expect(canVoidSettledOrder({ fiscalMode: true, status, action: 'cancel' })).toBe(true)
    }
  })

  it('gives a one-line message that says what to do instead', () => {
    const message = describeFiscalVoidRefusal({ fiscalMode: true, status: 'PAID', action: 'cancel' })

    expect(message).not.toBeNull()
    expect(message).not.toContain('\n')
    expect(message!.length).toBeLessThan(80)
    expect(message).toContain('refund')
  })
})

describe('fiscal mode off', () => {
  it('changes nothing at all', () => {
    // Every venue trading today is here. Any refusal in this block would be a
    // regression that stops a manager fixing a mis-keyed bill.
    for (const status of ['PAID', 'PENDING', 'OPEN', 'CANCELED']) {
      for (const action of ['cancel', 'delete'] as const) {
        expect(describeFiscalVoidRefusal({ fiscalMode: false, status, action })).toBeNull()
        expect(canVoidSettledOrder({ fiscalMode: false, status, action })).toBe(true)
      }
    }
  })
})

describe('isSettledOrderStatus', () => {
  it('recognises PAID whatever the casing or padding', () => {
    for (const status of ['PAID', 'paid', ' Paid ']) {
      expect(isSettledOrderStatus(status)).toBe(true)
    }
  })

  it('does not treat an unsettled or missing status as settled', () => {
    for (const status of ['PENDING', 'OPEN', 'CANCELED', 'MERGED', '', null, undefined]) {
      expect(isSettledOrderStatus(status)).toBe(false)
    }
  })
})

/**
 * Fiscal mode is a property of the BUILD, not a setting.
 *
 * What these tests defend is mostly an absence: there must be no way to turn
 * VAT off from inside a running fiscal build. If someone later adds a database
 * column or a settings toggle, the intent recorded here should stop them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { canIssueFiscalReceipts, describeFiscalConfigurationGap, isFiscalBuild, isFiscalClient } from '@/lib/fiscalMode'

const COMPLETE = {
  tin: '999999991',
  sdcId: 'SDC001000001',
  mrc: 'AAACC123456',
  rraBranchCode: '00',
  vsdcUrl: 'http://localhost:8080',
}

const original = process.env.RRA_FISCAL_MODE

beforeEach(() => {
  delete process.env.RRA_FISCAL_MODE
})

afterEach(() => {
  if (original === undefined) delete process.env.RRA_FISCAL_MODE
  else process.env.RRA_FISCAL_MODE = original
})

describe('isFiscalBuild', () => {
  it('is off unless the build says on', () => {
    expect(isFiscalBuild()).toBe(false)
  })

  it('is on only for exactly "on"', () => {
    process.env.RRA_FISCAL_MODE = 'on'
    expect(isFiscalBuild()).toBe(true)

    // Anything vague must NOT enable it. A build that half-enables VAT is worse
    // than one that does not: it would issue receipts nobody certified.
    for (const value of ['true', '1', 'yes', 'ON ', '', 'off']) {
      process.env.RRA_FISCAL_MODE = value
      expect(isFiscalBuild()).toBe(value.trim().toLowerCase() === 'on')
    }
  })
})

describe('a fiscal build that is not registered yet', () => {
  beforeEach(() => {
    process.env.RRA_FISCAL_MODE = 'on'
  })

  it('refuses to issue receipts rather than trading untaxed', () => {
    // The distinction this whole module exists for: missing configuration is
    // "stop", never "carry on without VAT".
    expect(canIssueFiscalReceipts({})).toBe(false)
  })

  it('names what is missing, in one line', () => {
    const message = describeFiscalConfigurationGap({ tin: '999999991' })

    expect(message).not.toBeNull()
    expect(message).not.toContain('\n')
    expect(message).toContain('SDC ID')
    // The TIN it does have is not listed as missing.
    expect(message).not.toContain('TIN,')
  })

  it('allows receipts once every field is set', () => {
    expect(describeFiscalConfigurationGap(COMPLETE)).toBeNull()
    expect(canIssueFiscalReceipts(COMPLETE)).toBe(true)
  })

  it('treats blank and whitespace as missing', () => {
    expect(canIssueFiscalReceipts({ ...COMPLETE, mrc: '   ' })).toBe(false)
    expect(canIssueFiscalReceipts({ ...COMPLETE, tin: '' })).toBe(false)
    expect(canIssueFiscalReceipts({ ...COMPLETE, sdcId: null })).toBe(false)
  })
})

describe('a non-fiscal build', () => {
  it('has nothing to configure and never blocks', () => {
    // Every venue trading today. No fiscal configuration exists for them, and
    // asking for it must not stop them serving.
    expect(describeFiscalConfigurationGap({})).toBeNull()
    expect(canIssueFiscalReceipts({})).toBe(true)
  })
})

describe('isFiscalClient', () => {
  // RRA_FISCAL_MODE is a server value and is simply absent from a client
  // bundle, which is why no screen behaved differently in the fiscal app until
  // this existed. Next inlines NEXT_PUBLIC_* at build time; this reads that.
  const originalPublic = process.env.NEXT_PUBLIC_RRA_FISCAL_MODE

  afterEach(() => {
    if (originalPublic === undefined) delete process.env.NEXT_PUBLIC_RRA_FISCAL_MODE
    else process.env.NEXT_PUBLIC_RRA_FISCAL_MODE = originalPublic
  })

  it('is true only for "on"', () => {
    process.env.NEXT_PUBLIC_RRA_FISCAL_MODE = 'on'
    expect(isFiscalClient()).toBe(true)
  })

  it('tolerates casing and stray whitespace', () => {
    for (const value of ['ON', ' on ', 'On']) {
      process.env.NEXT_PUBLIC_RRA_FISCAL_MODE = value
      expect(isFiscalClient()).toBe(true)
    }
  })

  it('is false for anything else, including absent', () => {
    // The safe direction: a screen that does not know it is fiscal shows the
    // ordinary bill, rather than a half-fiscal one.
    for (const value of ['', 'off', 'true', '1', 'yes']) {
      process.env.NEXT_PUBLIC_RRA_FISCAL_MODE = value
      expect(isFiscalClient()).toBe(false)
    }
    delete process.env.NEXT_PUBLIC_RRA_FISCAL_MODE
    expect(isFiscalClient()).toBe(false)
  })

  it('is independent of the server flag', () => {
    // They are set by one build command and cannot drift in practice, but they
    // are separate reads — this pins that neither answers for the other.
    process.env.RRA_FISCAL_MODE = 'on'
    delete process.env.NEXT_PUBLIC_RRA_FISCAL_MODE
    expect(isFiscalBuild()).toBe(true)
    expect(isFiscalClient()).toBe(false)
  })
})

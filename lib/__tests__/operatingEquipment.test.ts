import { describe, expect, it } from 'vitest'
import {
  applyMovement,
  isMovementKind,
  nextUnitCost,
  normalizeEquipmentName,
  sanitizeEquipmentName,
  signedMovementQuantity,
  toStockUnits,
} from '@/lib/operatingEquipment'

describe('toStockUnits', () => {
  // The example this was built for: bought in bottles, counted in ml.
  it('converts a pack into the unit stock is counted in', () => {
    const result = toStockUnits({ purchaseQuantity: 2, purchaseUnitCost: 3000, unitsPerPurchaseUnit: 500 })
    expect(result.quantity).toBe(1000)
    expect(result.unitCost).toBe(6)
    expect(result.factor).toBe(500)
  })

  // Buying 6 mop sticks and counting 6 mop sticks: nothing to convert.
  it('leaves a plain purchase alone', () => {
    const result = toStockUnits({ purchaseQuantity: 6, purchaseUnitCost: 1500, unitsPerPurchaseUnit: 1 })
    expect(result.quantity).toBe(6)
    expect(result.unitCost).toBe(1500)
  })

  // A missing or nonsense factor must not wipe the quantity out or divide by
  // zero — it falls back to treating the pack as one unit.
  it('falls back to a pack of one when the factor is missing or invalid', () => {
    for (const factor of [null, undefined, 0, -5, Number.NaN]) {
      const result = toStockUnits({ purchaseQuantity: 4, purchaseUnitCost: 200, unitsPerPurchaseUnit: factor as number })
      expect(result.quantity).toBe(4)
      expect(result.unitCost).toBe(200)
      expect(result.factor).toBe(1)
    }
  })

  it('handles a cost that divides unevenly without trailing dust', () => {
    const result = toStockUnits({ purchaseQuantity: 1, purchaseUnitCost: 1000, unitsPerPurchaseUnit: 3 })
    expect(result.unitCost).toBe(333.333)
  })

  it('copes with a missing cost', () => {
    const result = toStockUnits({ purchaseQuantity: 3, purchaseUnitCost: null, unitsPerPurchaseUnit: 750 })
    expect(result.quantity).toBe(2250)
    expect(result.unitCost).toBe(0)
  })
})

describe('equipment name matching', () => {
  // The delivery recorder resolves a typed line to an item by this key. If it
  // were case- or space-sensitive, every differently-typed spelling would start
  // a second item and split the stock level in two with no sign it happened.
  it('treats capitalisation and spacing as the same item', () => {
    const target = normalizeEquipmentName('Hand soap')
    expect(normalizeEquipmentName('hand soap')).toBe(target)
    expect(normalizeEquipmentName('  Hand   Soap  ')).toBe(target)
    expect(normalizeEquipmentName('HAND SOAP')).toBe(target)
  })

  it('keeps genuinely different items apart', () => {
    expect(normalizeEquipmentName('Hand soap')).not.toBe(normalizeEquipmentName('Hand towel'))
  })

  // Stored spelling keeps the user's capitalisation — only the key is folded.
  it('stores the name as typed, just tidied', () => {
    expect(sanitizeEquipmentName('  Hand   Soap  ')).toBe('Hand Soap')
    expect(sanitizeEquipmentName('Mop stick')).toBe('Mop stick')
  })
})

describe('signedMovementQuantity', () => {
  it('adds to stock on a purchase', () => {
    expect(signedMovementQuantity('purchase', 12)).toBe(12)
  })

  it('removes from stock on an issue', () => {
    expect(signedMovementQuantity('issue', 4)).toBe(-4)
  })

  // The form collects a count, not a delta. A manager who types "-4" into
  // "how many did you hand out" means four out — not four back in.
  it('ignores a typed minus on a purchase or an issue', () => {
    expect(signedMovementQuantity('purchase', -12)).toBe(12)
    expect(signedMovementQuantity('issue', -4)).toBe(-4)
  })

  // A stock take is the one place direction genuinely belongs to the user.
  it('keeps the sign on an adjustment, both ways', () => {
    expect(signedMovementQuantity('adjustment', 6)).toBe(6)
    expect(signedMovementQuantity('adjustment', -6)).toBe(-6)
  })
})

describe('applyMovement', () => {
  const base = { currentQuantity: 10, unit: 'piece' } as const

  it('raises stock when equipment is received', () => {
    const result = applyMovement({ ...base, kind: 'purchase', rawQuantity: 5 })
    expect(result).toEqual({ ok: true, delta: 5, nextQuantity: 15 })
  })

  it('lowers stock when equipment is issued', () => {
    const result = applyMovement({ ...base, kind: 'issue', rawQuantity: 3 })
    expect(result).toEqual({ ok: true, delta: -3, nextQuantity: 7 })
  })

  it('allows an issue that empties the shelf exactly', () => {
    const result = applyMovement({ ...base, kind: 'issue', rawQuantity: 10 })
    expect(result).toEqual({ ok: true, delta: -10, nextQuantity: 0 })
  })

  // Negative stock is never a real state, and once it happens the number stops
  // meaning anything with no way to tell how far off it drifted.
  it('refuses to issue more than is on hand', () => {
    const result = applyMovement({ ...base, kind: 'issue', rawQuantity: 11 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Only 10 piece on hand')
  })

  it('refuses a correction that would drive stock below zero', () => {
    const result = applyMovement({ ...base, kind: 'adjustment', rawQuantity: -11 })
    expect(result.ok).toBe(false)
  })

  it('allows a correction upwards', () => {
    const result = applyMovement({ ...base, kind: 'adjustment', rawQuantity: 4 })
    expect(result).toEqual({ ok: true, delta: 4, nextQuantity: 14 })
  })

  it('rejects a zero or unparseable quantity', () => {
    expect(applyMovement({ ...base, kind: 'purchase', rawQuantity: 0 }).ok).toBe(false)
    expect(applyMovement({ ...base, kind: 'purchase', rawQuantity: Number.NaN }).ok).toBe(false)
  })

  // Error text goes straight to the manager, so it stays one short line.
  it('keeps the refusal message to a single line', () => {
    const result = applyMovement({ ...base, kind: 'issue', rawQuantity: 99 })
    if (!result.ok) {
      expect(result.error).not.toContain('\n')
      expect(result.error.length).toBeLessThan(60)
    }
  })
})

describe('nextUnitCost', () => {
  it('takes the new price from a purchase', () => {
    expect(nextUnitCost({ kind: 'purchase', submittedUnitCost: 900, currentUnitCost: 700 })).toBe(900)
  })

  // An issue or a correction carries no price information. Trusting whatever
  // the form submitted there resets a good figure to zero on every stock take.
  it('leaves the price alone on an issue or a correction', () => {
    expect(nextUnitCost({ kind: 'issue', submittedUnitCost: 0, currentUnitCost: 700 })).toBe(700)
    expect(nextUnitCost({ kind: 'adjustment', submittedUnitCost: 0, currentUnitCost: 700 })).toBe(700)
  })

  it('keeps the standing price when a purchase omits one', () => {
    expect(nextUnitCost({ kind: 'purchase', submittedUnitCost: null, currentUnitCost: 700 })).toBe(700)
    expect(nextUnitCost({ kind: 'purchase', submittedUnitCost: 0, currentUnitCost: 700 })).toBe(700)
  })
})

describe('isMovementKind', () => {
  it('accepts the three real kinds and nothing else', () => {
    expect(isMovementKind('purchase')).toBe(true)
    expect(isMovementKind('issue')).toBe(true)
    expect(isMovementKind('adjustment')).toBe(true)
    expect(isMovementKind('consumption')).toBe(false)
    expect(isMovementKind(undefined)).toBe(false)
  })
})

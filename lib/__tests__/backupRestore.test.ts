import { describe, it, expect } from 'vitest'
import { hasBranchScopedBackupData } from '@/lib/backupUtils'

/**
 * Regression suite for the hasBranchScopedBackupData helper (lib/backupUtils.ts),
 * which is the production function used by app/api/restaurant/backup/route.ts.
 *
 * Original bug in route.ts:
 *   (backup.transactions?.length ?? 0)
 *   (backup.tables?.length ?? 0)   ← missing ||, JS treats line 1 as a function call
 * Any restore attempt threw TypeError before writing a single row.
 */

describe('hasBranchScopedBackupData (production helper)', () => {
  it('returns false for an empty backup', () => {
    expect(hasBranchScopedBackupData({})).toBe(false)
  })

  it('returns false when all arrays are empty', () => {
    expect(hasBranchScopedBackupData({
      transactions: [],
      tables: [],
      restaurantOrders: [],
      inventoryItems: [],
      dishes: [],
    })).toBe(false)
  })

  it('returns true when only transactions is non-empty', () => {
    expect(hasBranchScopedBackupData({ transactions: [{ id: 't1' }] })).toBe(true)
  })

  it('returns true when only tables is non-empty', () => {
    // This operand was silently lost by the missing || — the first term was called
    // as a function with tables.length as the argument, throwing TypeError.
    expect(hasBranchScopedBackupData({ tables: [{ id: 'tbl1' }] })).toBe(true)
  })

  it('returns true when only restaurantOrders is non-empty', () => {
    expect(hasBranchScopedBackupData({ restaurantOrders: [{ id: 'o1' }] })).toBe(true)
  })

  it('returns true when only dishes is non-empty', () => {
    expect(hasBranchScopedBackupData({ dishes: [{ id: 'd1' }] })).toBe(true)
  })

  it('returns true for a mixed backup with both transactions and tables', () => {
    expect(hasBranchScopedBackupData({
      transactions: [{ id: 't1' }, { id: 't2' }],
      tables: [{ id: 'tbl1' }],
      restaurantOrders: [],
    })).toBe(true)
  })

  it('bugfix — returns false when transactions is empty and tables is also empty (no TypeError)', () => {
    // Under the old bug, (0)(0) would still call 0 as a function — TypeError.
    // The fix: both evaluate to 0 and || with the rest returns false cleanly.
    expect(hasBranchScopedBackupData({ transactions: [], tables: [] })).toBe(false)
  })

  it('bugfix — returns true when transactions is empty but tables has rows (no TypeError)', () => {
    // Old code: (0)(1) → TypeError. Fixed code: 0 || 1 → 1 → true.
    expect(hasBranchScopedBackupData({ transactions: [], tables: [{ id: 'tbl1' }] })).toBe(true)
  })

  it('covers every branch-scoped array field', () => {
    const fields: Array<keyof Parameters<typeof hasBranchScopedBackupData>[0]> = [
      'transactions', 'tables', 'restaurantOrders', 'inventoryItems',
      'inventoryPurchases', 'inventoryAdjustmentLogs', 'inventoryBatchUsageLedgers',
      'dishes', 'dishSales', 'wasteLogs', 'employees', 'shifts', 'dailySummaries',
    ]
    for (const field of fields) {
      expect(hasBranchScopedBackupData({ [field]: [{ id: '1' }] })).toBe(true)
    }
  })
})

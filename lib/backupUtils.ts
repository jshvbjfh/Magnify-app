/**
 * Pure helpers for the backup restore route.
 * Kept in lib/ so they can be unit-tested without importing Next.js API machinery.
 */

export interface BackupSnapshot {
  transactions?: unknown[]
  tables?: unknown[]
  restaurantOrders?: unknown[]
  inventoryItems?: unknown[]
  inventoryPurchases?: unknown[]
  inventoryAdjustmentLogs?: unknown[]
  inventoryBatchUsageLedgers?: unknown[]
  dishes?: unknown[]
  dishSales?: unknown[]
  wasteLogs?: unknown[]
  employees?: unknown[]
  shifts?: unknown[]
  dailySummaries?: unknown[]
}

/**
 * Returns true if the backup contains any data that needs a target branchId
 * during restore. When true and no active branch is resolved, the restore
 * must be aborted to prevent branchId-less writes.
 */
export function hasBranchScopedBackupData(backup: BackupSnapshot): boolean {
  return Boolean(
    (backup.transactions?.length ?? 0)
    || (backup.tables?.length ?? 0)
    || (backup.restaurantOrders?.length ?? 0)
    || (backup.inventoryItems?.length ?? 0)
    || (backup.inventoryPurchases?.length ?? 0)
    || (backup.inventoryAdjustmentLogs?.length ?? 0)
    || (backup.inventoryBatchUsageLedgers?.length ?? 0)
    || (backup.dishes?.length ?? 0)
    || (backup.dishSales?.length ?? 0)
    || (backup.wasteLogs?.length ?? 0)
    || (backup.employees?.length ?? 0)
    || (backup.shifts?.length ?? 0)
    || (backup.dailySummaries?.length ?? 0)
  )
}

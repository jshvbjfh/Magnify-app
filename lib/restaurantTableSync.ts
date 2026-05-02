import type { Prisma, PrismaClient } from '@prisma/client'

import { enqueueSyncChange } from '@/lib/syncOutbox'

type PrismaDb = PrismaClient | Prisma.TransactionClient

export async function enqueueRestaurantTableSync(
  db: PrismaDb,
  tableId: string,
  restaurantId: string,
  sourceDeviceId?: string | null,
) {
  const table = await db.restaurantTable.findUnique({ where: { id: tableId } })
  if (!table || table.restaurantId !== restaurantId) return

  await enqueueSyncChange(db, {
    restaurantId,
    branchId: table.branchId ?? null,
    entityType: 'restaurantTable',
    entityId: table.id,
    operation: 'upsert',
    sourceDeviceId: sourceDeviceId ?? null,
    payload: table,
  })
}

export async function enqueueRestaurantTableDeleteSync(db: PrismaDb, params: { tableId: string; restaurantId: string; branchId?: string | null }) {
  await enqueueSyncChange(db, {
    restaurantId: params.restaurantId,
    branchId: params.branchId ?? null,
    entityType: 'restaurantTable',
    entityId: params.tableId,
    operation: 'delete',
    payload: { id: params.tableId, restaurantId: params.restaurantId, branchId: params.branchId ?? null },
  })
}
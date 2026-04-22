import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'

type RecordedRestaurantAction = {
  restaurantId: string
  branchId?: string | null
  userId: string
  actionKey: string
  actionType: string
  orderId?: string | null
  orderItemId?: string | null
  tableId?: string | null
  tableName?: string | null
}

export function normalizeRestaurantActionKey(value: unknown) {
  const normalized = String(value || '').trim()
  return normalized || null
}

export function isRestaurantActionConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }

  const target = Array.isArray(error.meta?.target)
    ? error.meta.target.map((entry) => String(entry))
    : []

  return target.includes('actionKey') && (target.includes('restaurantId') || target.includes('branchId'))
}

export async function findRestaurantAction(restaurantId: string, actionKey: string, branchId?: string | null) {
  return prisma.restaurantAction.findFirst({
    where: {
      restaurantId,
      actionKey,
      ...(branchId !== undefined ? { branchId: branchId ?? null } : {}),
    },
  })
}

export async function recordRestaurantAction(tx: Prisma.TransactionClient, action: RecordedRestaurantAction) {
  await tx.restaurantAction.create({
    data: {
      restaurantId: action.restaurantId,
      branchId: action.branchId ?? null,
      userId: action.userId,
      actionKey: action.actionKey,
      actionType: action.actionType,
      orderId: action.orderId ?? null,
      orderItemId: action.orderItemId ?? null,
      tableId: action.tableId ?? null,
      tableName: action.tableName ?? null,
    },
  })
}
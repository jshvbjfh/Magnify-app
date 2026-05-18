import { Prisma } from '@prisma/client'

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

type RestaurantActionRecord = {
  orderItemId?: string | null
  orderId?: string | null
  tableId?: string | null
  tableName?: string | null
}

// RestaurantAction model was removed in the schema refactor — these are stubs.
// Idempotency deduplication for order actions is no longer persisted.
export async function findRestaurantAction(
  _restaurantId: string,
  _actionKey: string,
  _branchId?: string | null,
): Promise<RestaurantActionRecord | null> {
  return null
}

export async function recordRestaurantAction(
  _tx: Prisma.TransactionClient,
  _action: RecordedRestaurantAction,
) {
  // no-op
}

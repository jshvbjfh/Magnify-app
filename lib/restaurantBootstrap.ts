import { getCanonicalCloudAppUrl } from '@/lib/cloudAuthBridge'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

export type RestaurantBootstrapStatus = {
  ready: boolean
  required: boolean
  isLocalFirst: boolean
  hasCloudBridge: boolean
  hasLocalData: boolean
  lastSuccessfulSyncAt: string | null
  message: string | null
}

export function isRestaurantBootstrapRole(role: unknown) {
  const normalizedRole = String(role ?? '').trim().toLowerCase()
  return normalizedRole === 'admin' || normalizedRole === 'waiter' || normalizedRole === 'kitchen'
}

export function isLocalFirstDesktopMode() {
  return String(process.env.ELECTRON_DATA_MODE ?? '').trim().toLowerCase() === 'local-first'
}

async function hasLocalRestaurantData(params: {
  restaurantId: string
  branchId: string | null
  billingUserId: string
}) {
  const branchScopedWhere = {
    userId: params.billingUserId,
    restaurantId: params.restaurantId,
    ...(params.branchId ? { branchId: params.branchId } : {}),
  }
  const restaurantScopedWhere = {
    restaurantId: params.restaurantId,
    ...(params.branchId ? { branchId: params.branchId } : {}),
  }

  const counts = await Promise.all([
    prisma.transaction.count({ where: branchScopedWhere }),
    prisma.dish.count({ where: branchScopedWhere }),
    prisma.inventoryItem.count({ where: branchScopedWhere }),
    prisma.employee.count({ where: branchScopedWhere }),
    prisma.restaurantOrder.count({ where: restaurantScopedWhere }),
    prisma.restaurantTable.count({ where: restaurantScopedWhere }),
    prisma.dishSale.count({ where: branchScopedWhere }),
    prisma.inventoryPurchase.count({ where: branchScopedWhere }),
    prisma.wasteLog.count({ where: branchScopedWhere }),
    prisma.shift.count({ where: branchScopedWhere }),
  ])

  return counts.some((count) => count > 0)
}

export async function getRestaurantBootstrapStatus(userId: string): Promise<RestaurantBootstrapStatus> {
  const isLocalFirst = isLocalFirstDesktopMode()
  const hasCloudBridge = Boolean(getCanonicalCloudAppUrl())

  if (!isLocalFirst || !hasCloudBridge) {
    return {
      ready: true,
      required: false,
      isLocalFirst,
      hasCloudBridge,
      hasLocalData: true,
      lastSuccessfulSyncAt: null,
      message: null,
    }
  }

  const context = await getRestaurantContextForUser(userId)
  if (!context?.restaurantId) {
    return {
      ready: false,
      required: true,
      isLocalFirst,
      hasCloudBridge,
      hasLocalData: false,
      lastSuccessfulSyncAt: null,
      message: 'No restaurant is linked to this device yet. Connect to the internet and retry sync before continuing.',
    }
  }

  const [hasLocalData, syncState] = await Promise.all([
    hasLocalRestaurantData({
      restaurantId: context.restaurantId,
      branchId: context.branchId,
      billingUserId: context.billingUserId,
    }),
    prisma.restaurantSyncState.findUnique({
      where: { restaurantId: context.restaurantId },
      select: { lastSuccessAt: true, lastErrorMessage: true },
    }),
  ])

  if (hasLocalData || syncState?.lastSuccessAt) {
    return {
      ready: true,
      required: false,
      isLocalFirst,
      hasCloudBridge,
      hasLocalData,
      lastSuccessfulSyncAt: syncState?.lastSuccessAt?.toISOString() ?? null,
      message: null,
    }
  }

  return {
    ready: false,
    required: true,
    isLocalFirst,
    hasCloudBridge,
    hasLocalData: false,
    lastSuccessfulSyncAt: null,
    message: syncState?.lastErrorMessage
      ? `Unable to load restaurant data on this device yet. ${syncState.lastErrorMessage}`
      : 'Unable to load restaurant data on this device yet. Connect to the internet and retry sync before continuing.',
  }
}
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
}) {
  const scopeWhere = {
    restaurantId: params.restaurantId,
    ...(params.branchId ? { branchId: params.branchId } : {}),
  }

  const counts = await Promise.all([
    prisma.journalEntry.count({ where: scopeWhere }),
    prisma.dish.count({ where: scopeWhere }),
    prisma.inventoryItem.count({ where: scopeWhere }),
    prisma.staff.count({ where: { restaurantId: params.restaurantId } }),
    prisma.restaurantOrder.count({ where: scopeWhere }),
    prisma.restaurantTable.count({ where: scopeWhere }),
    prisma.dishSale.count({ where: scopeWhere }),
    prisma.inventoryPurchase.count({ where: scopeWhere }),
    prisma.wasteLog.count({ where: scopeWhere }),
    prisma.employeeShift.count({ where: scopeWhere }),
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

  const hasLocalData = await hasLocalRestaurantData({
    restaurantId: context.restaurantId,
    branchId: context.branchId,
  })

  if (hasLocalData) {
    return {
      ready: true,
      required: false,
      isLocalFirst,
      hasCloudBridge,
      hasLocalData,
      lastSuccessfulSyncAt: null,
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
    message: 'Unable to load restaurant data on this device yet. Connect to the internet and retry sync before continuing.',
  }
}

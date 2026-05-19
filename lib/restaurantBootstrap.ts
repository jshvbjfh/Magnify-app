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
}) {
  // Check restaurant-level only — not branch-scoped. Old DBs may have data under
  // a different branchId than the newly seeded one; branch-scoping would always
  // return 0 for legacy installs and incorrectly trigger the bootstrap gate.
  const r = params.restaurantId
  const counts = await Promise.all([
    prisma.dish.count({ where: { restaurantId: r } }),
    prisma.inventoryItem.count({ where: { restaurantId: r } }),
    prisma.staff.count({ where: { restaurantId: r } }),
    prisma.restaurantOrder.count({ where: { restaurantId: r } }),
    prisma.restaurantTable.count({ where: { restaurantId: r } }),
    prisma.dishSale.count({ where: { restaurantId: r } }),
    prisma.inventoryPurchase.count({ where: { restaurantId: r } }),
    prisma.wasteLog.count({ where: { restaurantId: r } }),
    prisma.journalEntry.count({ where: { restaurantId: r } }),
    prisma.employeeShift.count({ where: { restaurantId: r } }),
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

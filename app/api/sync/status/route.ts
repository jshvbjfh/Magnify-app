import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'
import { getCanonicalCloudAppUrl } from '@/lib/cloudAuthBridge'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { getSyncDeviceId, GLOBAL_SYNC_SCOPE_ID, SYNC_OUTBOX_MAX_ATTEMPTS } from '@/lib/syncOutbox'

type DeviceEntry = {
  deviceId: string
  appVersion: string
  status: string
  lastSeenAt: string | null
  pendingOutboxChanges: number
  readyOutboxChanges: number
  stalledOutboxChanges: number
  nextRetryAt: string | null
  isCurrentDevice: boolean
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = session.user as any
  if (!['admin', 'waiter', 'kitchen'].includes(String(user.role))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const context = await getRestaurantContextForUser(session.user.id)
  const restaurant = context?.restaurant ?? null
  const branchId = context?.branchId ?? null
  if (!restaurant) return NextResponse.json({ error: 'No restaurant linked' }, { status: 404 })

  const currentDeviceId = getSyncDeviceId()
  const targetUrl = String(process.env.OWNER_SYNC_TARGET_URL ?? getCanonicalCloudAppUrl() ?? '').trim()
  const sessionEmail = typeof session.user.email === 'string' ? session.user.email.trim().toLowerCase() : ''
  const email = String(process.env.OWNER_SYNC_EMAIL ?? sessionEmail).trim().toLowerCase()
  const usesSharedSecret = Boolean(String(process.env.OWNER_SYNC_SHARED_SECRET ?? '').trim())
  const hasPassword = Boolean(String(process.env.OWNER_SYNC_PASSWORD ?? '').trim())
  const serverManagedConfigured = Boolean(targetUrl && email && (usesSharedSecret || hasPassword))

  const [outboxRows, syncConflictCount, syncCursors, branchDevices] = await Promise.all([
    prisma.syncOutbox.findMany({
      where: {
        scopeId: { in: [restaurant.id, GLOBAL_SYNC_SCOPE_ID] },
        syncedAt: null,
        OR: [
          { scopeId: GLOBAL_SYNC_SCOPE_ID },
          { branchId: branchId ?? null },
        ],
      },
      select: {
        id: true,
        scopeId: true,
        restaurantId: true,
        branchId: true,
        sourceDeviceId: true,
        attempts: true,
        availableAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.syncConflictLog.count({
      where: {
        OR: [
          { scopeId: GLOBAL_SYNC_SCOPE_ID },
          { restaurantId: restaurant.id, ...(branchId ? { branchId } : { branchId: null }) },
        ],
      },
    }),
    prisma.syncCursor.findMany({ where: { scopeId: { in: [restaurant.id, GLOBAL_SYNC_SCOPE_ID] } }, orderBy: { scopeId: 'asc' } }),
    prisma.branchDevice.findMany({
      where: {
        restaurantId: restaurant.id,
        OR: [
          { branchId: branchId ?? null },
          { branchId: null },
        ],
      },
      orderBy: { lastSeenAt: 'desc' },
    }),
  ])

  const now = Date.now()
  const deviceMap = new Map<string, DeviceEntry>(
    branchDevices.map((device) => [
      device.deviceId,
      {
        deviceId: device.deviceId,
        appVersion: device.appVersion,
        status: device.status,
        lastSeenAt: device.lastSeenAt.toISOString(),
        pendingOutboxChanges: 0,
        readyOutboxChanges: 0,
        stalledOutboxChanges: 0,
        nextRetryAt: null,
        isCurrentDevice: device.deviceId === currentDeviceId,
      },
    ]),
  )

  let readyOutboxChanges = 0
  let stalledOutboxChanges = 0
  let nextRetryAt: Date | null = null

  for (const row of outboxRows) {
    const sourceDeviceId = row.sourceDeviceId || 'unknown'
    const current: DeviceEntry = deviceMap.get(sourceDeviceId) ?? {
      deviceId: sourceDeviceId,
      appVersion: 'unknown',
      status: 'unknown',
      lastSeenAt: null,
      pendingOutboxChanges: 0,
      readyOutboxChanges: 0,
      stalledOutboxChanges: 0,
      nextRetryAt: null,
      isCurrentDevice: sourceDeviceId === currentDeviceId,
    }

    current.pendingOutboxChanges += 1

    if (row.attempts >= SYNC_OUTBOX_MAX_ATTEMPTS) {
      current.stalledOutboxChanges += 1
      stalledOutboxChanges += 1
    } else if (!row.availableAt || row.availableAt.getTime() <= now) {
      current.readyOutboxChanges += 1
      readyOutboxChanges += 1
    }

    if (row.availableAt && (!nextRetryAt || row.availableAt < nextRetryAt)) {
      nextRetryAt = row.availableAt
    }

    if (row.availableAt && (!current.nextRetryAt || row.availableAt < new Date(current.nextRetryAt))) {
      current.nextRetryAt = row.availableAt.toISOString()
    }

    deviceMap.set(sourceDeviceId, current)
  }

  const pendingOutboxChanges = outboxRows.length

  return NextResponse.json({
    restaurantId: restaurant.id,
    currentDeviceId,
    currentStatus: 'idle',
    branchLinked: false,
    serverManagedConfigured,
    canServerManagedSync: false,
    recoveryRequired: false,
    failedBatchCount: 0,
    processingBatchCount: 0,
    pendingTransactions: 0,
    pendingSummaries: 0,
    pendingOutboxChanges,
    readyOutboxChanges,
    stalledOutboxChanges,
    nextRetryAt: nextRetryAt?.toISOString() ?? null,
    syncConflictCount,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    consecutiveFailures: 0,
    lastSyncedTransactions: 0,
    lastSyncedSummaries: 0,
    syncCursors: syncCursors.map((cursor) => ({
      scopeId: cursor.scopeId,
      target: cursor.target,
      lastPulledAt: cursor.lastPulledAt?.toISOString() ?? null,
      lastPushedAt: cursor.lastPushedAt?.toISOString() ?? null,
      updatedAt: cursor.updatedAt.toISOString(),
    })),
    recentEvents: [],
    devices: Array.from(deviceMap.values()).sort((left, right) => {
      if (left.isCurrentDevice !== right.isCurrentDevice) return left.isCurrentDevice ? -1 : 1
      return (right.lastSeenAt || '').localeCompare(left.lastSeenAt || '')
    }),
    recentBatches: [],
  })
}

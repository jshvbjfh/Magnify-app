import { beforeEach, describe, expect, it, vi } from 'vitest'

const getTokenMock = vi.hoisted(() => vi.fn())
const invalidateSessionMock = vi.hoisted(() => vi.fn())
const getConfigMock = vi.hoisted(() => vi.fn())
const setConfigMock = vi.hoisted(() => vi.fn())
const getDishesMock = vi.hoisted(() => vi.fn())
const getTablesMock = vi.hoisted(() => vi.fn())
const replaceDishesMock = vi.hoisted(() => vi.fn())
const replaceTablesMock = vi.hoisted(() => vi.fn())
const replaceCancellationApproversMock = vi.hoisted(() => vi.fn())
const reconcileOrderStatusesMock = vi.hoisted(() => vi.fn())
const sendRequestMock = vi.hoisted(() => vi.fn())
const getResponseHeaderMock = vi.hoisted(() => vi.fn())
const responseDataToRecordMock = vi.hoisted(() => vi.fn())
const responseDataToTextMock = vi.hoisted(() => vi.fn())
const logErrorMock = vi.hoisted(() => vi.fn())
const logWarnMock = vi.hoisted(() => vi.fn())
const logInfoMock = vi.hoisted(() => vi.fn())

vi.mock('../auth', () => ({
  getToken: getTokenMock,
  invalidateSession: invalidateSessionMock,
  SESSION_INVALID_MESSAGE: 'Session expired',
}))

vi.mock('../../config', () => ({
  API: {
    pull: 'https://example.test/api/mobile/pull',
    push: 'https://example.test/api/mobile/push',
  },
}))

vi.mock('../db', () => ({
  replaceDishes: replaceDishesMock,
  replaceTables: replaceTablesMock,
  setConfig: setConfigMock,
  getConfig: getConfigMock,
  getDishes: getDishesMock,
  getTables: getTablesMock,
  getUnsyncedOrders: vi.fn(),
  markOrdersSynced: vi.fn(),
  replaceCancellationApprovers: replaceCancellationApproversMock,
  getCancellationApprovers: vi.fn(),
  reconcileOrderStatuses: reconcileOrderStatusesMock,
  getUnsyncedShifts: vi.fn(() => Promise.resolve([])),
  markShiftsSynced: vi.fn(),
  upsertShiftFromServer: vi.fn(),
  reconcileNoOpenShift: vi.fn(),
}))

vi.mock('../http', () => ({
  getResponseHeader: getResponseHeaderMock,
  responseDataToRecord: responseDataToRecordMock,
  responseDataToText: responseDataToTextMock,
  sendRequest: sendRequestMock,
}))

vi.mock('../logger', () => ({
  logError: logErrorMock,
  logWarn: logWarnMock,
  logInfo: logInfoMock,
}))

import { pullSync } from '../sync'

describe('pullSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    getTokenMock.mockResolvedValue('token-1')
    getConfigMock.mockImplementation(async (key: string) => {
      if (key === 'branchId') return 'branch-1'
      if (key === 'activeBranchId') return null
      return null
    })
    sendRequestMock.mockResolvedValue({ status: 200, data: { ok: true } })
    responseDataToTextMock.mockReturnValue('')
    setConfigMock.mockResolvedValue(undefined)
    replaceDishesMock.mockResolvedValue(undefined)
    replaceTablesMock.mockResolvedValue(undefined)
    replaceCancellationApproversMock.mockResolvedValue(undefined)
    reconcileOrderStatusesMock.mockResolvedValue(undefined)
    logWarnMock.mockResolvedValue(undefined)
    logErrorMock.mockResolvedValue(undefined)
    logInfoMock.mockResolvedValue(undefined)
  })

  // An empty pull is treated as suspect, not authoritative: a transient server
  // error or a misconfigured station both return 0 dishes, and wiping the cache
  // on that would leave a waiter with no menu and no way back offline. The
  // cache is kept and the waiter is told what they're looking at instead.
  // See the sync-safety change in 56c2584.
  it('keeps the cached menu and tables on an empty pull and warns instead', async () => {
    getDishesMock.mockResolvedValue([
      {
        id: 'dish-1',
        name: 'Old Dish',
        selling_price: 10,
        category: null,
        is_active: 1,
        branch_id: 'branch-1',
        restaurant_id: 'rest-1',
      },
    ])
    getTablesMock.mockResolvedValue([
      {
        id: 'table-1',
        name: 'T1',
        seats: 4,
        status: 'available',
        branch_id: 'branch-1',
        restaurant_id: 'rest-1',
      },
    ])
    responseDataToRecordMock.mockReturnValue({
      parsedFromJson: true,
      body: {
        dishes: [],
        tables: [],
        restaurant: { id: 'rest-1', name: 'Erick Pizzeria' },
        branches: [],
      },
    })

    const result = await pullSync()

    expect(replaceDishesMock).not.toHaveBeenCalled()
    expect(replaceTablesMock).not.toHaveBeenCalled()
    expect(result).toEqual({
      warning: 'This station currently has no menu. Showing your cached menu. This station currently has no tables.',
    })
    // Nothing was taken from the server, so the pull clock must not advance —
    // otherwise a run of empty pulls would look like a series of good syncs.
    expect(setConfigMock).not.toHaveBeenCalledWith('lastPulledAt', expect.any(String))
  })

  // Nothing cached and nothing pulled is the one case with no menu to fall back
  // on, so it fails loudly rather than leaving the waiter on an empty screen.
  it('raises a no-menu error when there is no cached menu to fall back on', async () => {
    getDishesMock.mockResolvedValue([])
    getTablesMock.mockResolvedValue([
      {
        id: 'table-1',
        name: 'T1',
        seats: 4,
        status: 'available',
        branch_id: 'branch-1',
        restaurant_id: 'rest-1',
      },
    ])
    responseDataToRecordMock.mockReturnValue({
      parsedFromJson: true,
      body: {
        dishes: [],
        tables: [],
        restaurant: { id: 'rest-1', name: 'Erick Pizzeria' },
        branches: [],
      },
    })

    await expect(pullSync()).rejects.toThrow(
      'No menu is available for your assigned station. Ask your manager to sync the station menu and verify your station assignment.',
    )

    // Even on the error path the cache is left alone — the waiter's existing
    // tables survive a bad pull.
    expect(replaceDishesMock).not.toHaveBeenCalled()
    expect(replaceTablesMock).not.toHaveBeenCalled()
    expect(logErrorMock).toHaveBeenCalledWith('sync', 'Pull returned no menu for assigned branch', {
      restaurantId: 'rest-1',
      branchId: 'branch-1',
      dishes: 0,
      tables: 0,
    })
  })
})
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

  it('clears branch-scoped cached menu and tables on an authoritative empty pull', async () => {
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

    expect(replaceDishesMock).toHaveBeenCalledWith([], {
      branchId: 'branch-1',
      restaurantId: 'rest-1',
    })
    expect(replaceTablesMock).toHaveBeenCalledWith([], {
      branchId: 'branch-1',
      restaurantId: 'rest-1',
    })
    expect(result).toEqual({
      warning: 'This branch currently has no menu. This branch currently has no tables.',
    })
    expect(setConfigMock).toHaveBeenCalledWith('lastPulledAt', expect.any(String))
  })

  it('clears the active branch snapshot before surfacing a no-menu error', async () => {
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
      'No menu is available for your assigned branch. Ask your manager to sync the branch menu and verify your branch assignment.',
    )

    expect(replaceDishesMock).toHaveBeenCalledWith([], {
      branchId: 'branch-1',
      restaurantId: 'rest-1',
    })
    expect(replaceTablesMock).toHaveBeenCalledWith([], {
      branchId: 'branch-1',
      restaurantId: 'rest-1',
    })
    expect(logErrorMock).toHaveBeenCalledWith('sync', 'Pull returned no menu for assigned branch', {
      restaurantId: 'rest-1',
      branchId: 'branch-1',
      dishes: 0,
      tables: 0,
    })
  })
})
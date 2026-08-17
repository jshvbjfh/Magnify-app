// Service sessions ("shifts"). A supervisor opens the venue for the day and
// closes it at the end; every order taken in between is stamped with the shift
// and its business day. Works offline: the supervisor PIN is validated against
// the bcrypt hashes cached from the last pull, the shift is written locally, and
// it syncs to the server on the next connection.

import { getOpenShift, saveShiftLocal, getConfig, getOrders, type Shift } from './db'
import { validateCancellationPinOffline } from './sync'

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `shift-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// The business day a shift opened, anchored to 00:00 Kigali (UTC+2, no DST) —
// exactly what the server's startOfRestaurantDay produces, so reports line up.
function kigaliBusinessDateISO(now = new Date()): string {
  const kigali = new Date(now.getTime() + 2 * 60 * 60 * 1000)
  const y = kigali.getUTCFullYear()
  const m = String(kigali.getUTCMonth() + 1).padStart(2, '0')
  const d = String(kigali.getUTCDate()).padStart(2, '0')
  return new Date(`${y}-${m}-${d}T00:00:00.000+02:00`).toISOString()
}

// Statuses that count as "still open" for the end-of-shift settle check.
const UNSETTLED_STATUSES = ['PENDING', 'OPEN', 'UNCONFIRMED']

// Whether this venue runs shifts at all, as of the last pull. Only an explicit
// '0' disables them: a fresh install that has never synced, or a server too old
// to send the flag, must keep the shift gate up rather than fall open.
export async function areShiftsEnabled(): Promise<boolean> {
  return (await getConfig('shiftsEnabled'))?.trim() !== '0'
}

// The shift to stamp new orders with. Null when the venue has shifts switched
// off, so those orders carry no shift and report by paidAt instead — orders
// already stamped keep the shift they were taken in.
export async function getActiveShift(): Promise<Shift | null> {
  if (!(await areShiftsEnabled())) return null
  const restaurantId = (await getConfig('restaurantId'))?.trim() || null
  return getOpenShift(restaurantId)
}

// Open a shift. Validates the supervisor PIN (offline-capable), refuses if one
// is already open, and writes the shift locally so orders can start immediately
// even with no connection; it syncs up on the next pull/push.
export async function startShift(supervisorPin: string): Promise<Shift> {
  const restaurantId = (await getConfig('restaurantId'))?.trim() || ''
  if (!restaurantId) throw new Error('No restaurant loaded yet — connect and sync first.')

  const existing = await getOpenShift(restaurantId)
  if (existing) return existing

  const { approvedBy } = await validateCancellationPinOffline(supervisorPin)

  const now = new Date().toISOString()
  const deviceId = (await getConfig('deviceId'))?.trim() || null
  const shift: Shift = {
    id: newId(),
    restaurant_id: restaurantId,
    business_date: kigaliBusinessDateISO(),
    status: 'OPEN',
    opened_at: now,
    opened_by_name: approvedBy,
    opened_by_staff_id: null,
    closed_at: null,
    closed_by_name: null,
    closed_by_staff_id: null,
    source_device_id: deviceId,
    synced: 0,
    created_at: now,
    updated_at: now,
  }
  await saveShiftLocal(shift)
  return shift
}

// Count orders that still need settling before a shift can close.
export async function getUnsettledOrderCount(): Promise<number> {
  const restaurantId = (await getConfig('restaurantId'))?.trim() || null
  const open = await getOrders({ statuses: UNSETTLED_STATUSES, restaurantId })
  return open.length
}

// Close the open shift. Blocks while any order is still open/unpaid — everything
// must be settled first. Validates the supervisor PIN. Offline-capable.
export async function endShift(supervisorPin: string): Promise<{ unsettled: number } | Shift> {
  const restaurantId = (await getConfig('restaurantId'))?.trim() || ''
  const open = await getOpenShift(restaurantId)
  if (!open) throw new Error('No shift is currently open.')

  const unsettled = await getUnsettledOrderCount()
  if (unsettled > 0) return { unsettled }

  const { approvedBy } = await validateCancellationPinOffline(supervisorPin)

  const now = new Date().toISOString()
  const closed: Shift = {
    ...open,
    status: 'CLOSED',
    closed_at: now,
    closed_by_name: approvedBy,
    updated_at: now,
    synced: 0,
  }
  await saveShiftLocal(closed)
  return closed
}

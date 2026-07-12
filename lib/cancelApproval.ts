import bcrypt from 'bcryptjs'

import { prisma } from '@/lib/prisma'

const CANCELLATION_PIN_REGEX = /^\d{5}$/

export function isValidCancellationPin(pin: string) {
  return CANCELLATION_PIN_REGEX.test(pin)
}

export async function hashCancellationPin(pin: string) {
  return bcrypt.hash(pin, 10)
}

export async function resolveCancellationApprover(params: {
  restaurantId?: string | null
  branchId?: string | null
  pin: string
}) {
  const normalizedPin = String(params.pin || '').trim()
  if (!isValidCancellationPin(normalizedPin)) return null

  // Employees (and their cancellation PINs) are restaurant-wide, not scoped to a single
  // station, so an approver's PIN works no matter which station the cancellation happens at.
  const staffList = await prisma.staff.findMany({
    where: {
      ...(params.restaurantId ? { restaurantId: params.restaurantId } : {}),
      isActive: true,
      cancellationPin: { not: null },
    },
    select: {
      id: true,
      name: true,
      cancellationPin: true,
    },
  })

  for (const staff of staffList) {
    if (!staff.cancellationPin) continue
    try {
      const matches = await bcrypt.compare(normalizedPin, staff.cancellationPin)
      if (matches) return { id: staff.id, name: staff.name }
    } catch {
      if (staff.cancellationPin === normalizedPin) return { id: staff.id, name: staff.name }
    }
  }

  return null
}

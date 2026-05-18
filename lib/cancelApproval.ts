import bcrypt from 'bcryptjs'

import { prisma } from '@/lib/prisma'

const CANCELLATION_PIN_REGEX = /^\d{4,6}$/

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

  const staffList = await prisma.staff.findMany({
    where: {
      ...(params.restaurantId ? { restaurantId: params.restaurantId } : {}),
      isActive: true,
      pin: { not: null },
      ...(params.branchId ? { branches: { some: { branchId: params.branchId } } } : {}),
    },
    select: {
      id: true,
      name: true,
      pin: true,
    },
  })

  for (const staff of staffList) {
    if (!staff.pin) continue
    try {
      const matches = await bcrypt.compare(normalizedPin, staff.pin)
      if (matches) return { id: staff.id, name: staff.name }
    } catch {
      // PIN is stored as plain text — compare directly
      if (staff.pin === normalizedPin) return { id: staff.id, name: staff.name }
    }
  }

  return null
}

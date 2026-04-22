import bcrypt from 'bcryptjs'

import { prisma } from '@/lib/prisma'

const CANCELLATION_PIN_REGEX = /^\d{5}$/

export function isValidCancellationPin(pin: string) {
  return CANCELLATION_PIN_REGEX.test(pin)
}

export async function hashCancellationPin(pin: string) {
  return bcrypt.hash(pin, 10)
}

export async function resolveCancellationApprover(params: { billingUserId: string; restaurantId?: string | null; branchId?: string | null; pin: string }) {
  const normalizedPin = String(params.pin || '').trim()
  if (!isValidCancellationPin(normalizedPin)) return null

  const employees = await prisma.employee.findMany({
    where: {
      userId: params.billingUserId,
      ...(params.restaurantId ? { restaurantId: params.restaurantId } : {}),
      ...(params.branchId ? { branchId: params.branchId } : {}),
      isActive: true,
      canApproveOrderCancellation: true,
      cancellationPinHash: { not: null },
    },
    select: {
      id: true,
      name: true,
      cancellationPinHash: true,
    },
  })

  for (const employee of employees) {
    if (!employee.cancellationPinHash) continue
    const matches = await bcrypt.compare(normalizedPin, employee.cancellationPinHash)
    if (matches) {
      return { id: employee.id, name: employee.name }
    }
  }

  return null
}
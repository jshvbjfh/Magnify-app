import type { Prisma, PrismaClient } from '@prisma/client'

type PrismaDb = PrismaClient | Prisma.TransactionClient

export async function ensureRestaurantStaffLoginUser(
  db: PrismaDb,
  params: {
    id: string
    email: string
    name: string
    passwordHash: string
    role: 'waiter' | 'kitchen'
    isActive?: boolean
  },
) {
  const normalizedEmail = params.email.trim().toLowerCase()
  const existingByEmail = await db.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  })

  if (existingByEmail && existingByEmail.id !== params.id) {
    throw new Error('Email already in use')
  }

  return db.user.upsert({
    where: { id: params.id },
    update: {
      email: normalizedEmail,
      name: params.name,
      password: params.passwordHash,
      role: params.role,
      isActive: params.isActive ?? true,
    },
    create: {
      id: params.id,
      email: normalizedEmail,
      name: params.name,
      password: params.passwordHash,
      role: params.role,
      isActive: params.isActive ?? true,
    },
    select: { id: true },
  })
}
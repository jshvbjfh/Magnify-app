import { prisma } from '@/lib/prisma'
import { ensureMainBranchForRestaurant } from '@/lib/restaurantAccess'

export async function resolveActiveStaffAccess(staffId: string) {
  const normalizedStaffId = String(staffId ?? '').trim()
  if (!normalizedStaffId) return null

  const staff = await prisma.staff.findUnique({
    where: { id: normalizedStaffId },
    select: { id: true, restaurantId: true, isActive: true, deletedAt: true },
  })

  if (!staff || !staff.isActive || staff.deletedAt) return null

  const assignment = await prisma.staffBranch.findFirst({
    where: {
      staffId: staff.id,
      branch: { restaurantId: staff.restaurantId, isActive: true },
    },
    include: { branch: { select: { id: true } } },
    orderBy: { createdAt: 'asc' },
  })

  const branchId = assignment?.branch.id ?? (await ensureMainBranchForRestaurant(staff.restaurantId))?.id ?? null
  if (!branchId) return null

  return {
    staffId: staff.id,
    restaurantId: staff.restaurantId,
    branchId,
  }
}
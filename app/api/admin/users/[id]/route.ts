import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const { isActive, licenseExpiry } = body

  const userUpdate: Record<string, unknown> = {}
  if (typeof isActive === 'boolean') userUpdate.isActive = isActive

  const restaurantUpdate: Record<string, unknown> = {}
  if (typeof isActive === 'boolean') restaurantUpdate.licenseActive = isActive
  if (licenseExpiry !== undefined) {
    restaurantUpdate.licenseExpiry = licenseExpiry ? new Date(licenseExpiry) : null
  }

  const user = await prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { id: params.id },
      data: userUpdate,
      select: { id: true, isActive: true },
    })
    if (Object.keys(restaurantUpdate).length > 0) {
      await tx.restaurant.updateMany({ where: { ownerId: params.id }, data: restaurantUpdate })
    }
    return updatedUser
  })

  return NextResponse.json(user)
}

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const { isActive } = body

  const data: Record<string, unknown> = {}
  if (typeof isActive === 'boolean') data.isActive = isActive

  const user = await prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { id: params.id },
      data,
      select: { id: true, isActive: true },
    })

    const restaurantData: Record<string, unknown> = {}
    if (typeof isActive === 'boolean') restaurantData.licenseActive = isActive

    if (Object.keys(restaurantData).length > 0) {
      await tx.restaurant.updateMany({ where: { ownerId: params.id }, data: restaurantData })
    }

    return updatedUser
  })

  return NextResponse.json(user)
}

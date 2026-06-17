import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json(null, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.branchId) return NextResponse.json(null, { status: 404 })

  const branch = await prisma.branch.findUnique({
    where: { id: context.branchId },
    select: { id: true, name: true, type: true },
  })

  return NextResponse.json(branch)
}

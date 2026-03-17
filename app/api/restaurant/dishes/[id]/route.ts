import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const data = await req.json()
  const dish = await prisma.dish.updateMany({
    where: { id: params.id, userId: session.user.id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.sellingPrice !== undefined && { sellingPrice: Number(data.sellingPrice) }),
      ...(data.category !== undefined && { category: data.category }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    }
  })
  return NextResponse.json(dish)
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await prisma.dish.deleteMany({ where: { id: params.id, userId: session.user.id } })
  return NextResponse.json({ success: true })
}

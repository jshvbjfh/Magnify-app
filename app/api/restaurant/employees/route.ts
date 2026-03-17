import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const employees = await prisma.employee.findMany({
    where: { userId: session.user.id },
    orderBy: { name: 'asc' }
  })
  return NextResponse.json(employees)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { name, role, payType, payRate, phone } = await req.json()
  if (!name || !role || !payType || payRate == null) {
    return NextResponse.json({ error: 'name, role, payType, payRate required' }, { status: 400 })
  }

  const employee = await prisma.employee.create({
    data: { userId: session.user.id, name, role, payType, payRate: Number(payRate), phone: phone || null }
  })
  return NextResponse.json(employee, { status: 201 })
}

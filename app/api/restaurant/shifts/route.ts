import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const shifts = await prisma.shift.findMany({
    where: {
      userId: session.user.id,
      ...(from && to && { date: { gte: new Date(from), lte: new Date(to) } })
    },
    include: { employee: true },
    orderBy: { date: 'desc' }
  })
  return NextResponse.json(shifts)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { employeeId, date, hoursWorked, notes } = await req.json()
  if (!employeeId || !date || hoursWorked == null) {
    return NextResponse.json({ error: 'employeeId, date, hoursWorked required' }, { status: 400 })
  }

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } })
  if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  const hours = Number(hoursWorked)

  // Calculate wage based on pay type
  let calculatedWage = 0
  if (employee.payType === 'hourly') {
    calculatedWage = employee.payRate * hours
  } else if (employee.payType === 'daily') {
    calculatedWage = employee.payRate // fixed per shift
  } else if (employee.payType === 'monthly') {
    // Prorate: monthly ÷ (26 working days × 8 hours) × hours_worked
    calculatedWage = (employee.payRate / (26 * 8)) * hours
  }

  // Find or create Labor category + account
  let laborCategory = await prisma.category.findFirst({ where: { name: 'Labor Cost' } })
  if (!laborCategory) {
    laborCategory = await prisma.category.create({
      data: { name: 'Labor Cost', type: 'expense', description: 'Staff wages and salaries' }
    })
  }
  let laborAccount = await prisma.account.findFirst({ where: { name: 'Staff Wages' } })
  if (!laborAccount) {
    laborAccount = await prisma.account.create({
      data: {
        code: 'REST-LAB-001',
        name: 'Staff Wages',
        categoryId: laborCategory.id,
        type: 'expense',
        description: 'Restaurant labor expense'
      }
    })
  }

  // Auto-create expense transaction
  await prisma.transaction.create({
    data: {
      userId: session.user.id,
      accountId: laborAccount.id,
      categoryId: laborCategory.id,
      date: new Date(date),
      description: `Wages: ${employee.name} (${hours}h)`,
      amount: calculatedWage,
      type: 'debit',
      isManual: true,
      paymentMethod: 'Cash'
    }
  })

  const shift = await prisma.shift.create({
    data: {
      userId: session.user.id,
      employeeId,
      date: new Date(date),
      hoursWorked: hours,
      calculatedWage,
      notes: notes || null
    }
  })

  return NextResponse.json({ shift, calculatedWage }, { status: 201 })
}

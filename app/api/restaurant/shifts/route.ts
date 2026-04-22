import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { recordJournalEntry } from '@/lib/accounting'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  const billingUserId = context?.billingUserId ?? session.user.id
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null

  if (!restaurantId || !branchId) return NextResponse.json([])

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const shifts = await prisma.shift.findMany({
    where: {
      userId: billingUserId,
      restaurantId,
      branchId,
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

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const billingUserId = context.billingUserId
  const restaurantId = context.restaurantId
  const branchId = context.branchId

  const { employeeId, date, hoursWorked, notes } = await req.json()
  if (!employeeId || !date || hoursWorked == null) {
    return NextResponse.json({ error: 'employeeId, date, hoursWorked required' }, { status: 400 })
  }

  const employee = await prisma.employee.findFirst({ where: { id: employeeId, userId: billingUserId, restaurantId, branchId } })
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

  const shiftDate = new Date(date)
  if (Number.isNaN(shiftDate.getTime())) {
    return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
  }

  const shift = await prisma.$transaction(async (tx) => {
    await recordJournalEntry(tx, {
      userId: billingUserId,
      restaurantId,
      branchId,
      date: shiftDate,
      description: `Wages: ${employee.name} (${hours}h)`,
      amount: calculatedWage,
      direction: 'out',
      accountName: 'Staff Wages',
      categoryType: 'expense',
      paymentMethod: 'Cash',
      isManual: false,
      sourceKind: 'shift_wage',
    })

    const createdShift = await tx.shift.create({
      data: {
        userId: billingUserId,
        restaurantId,
        branchId,
        employeeId,
        date: shiftDate,
        hoursWorked: hours,
        calculatedWage,
        notes: notes || null
      }
    })

    await enqueueSyncChange(tx, {
      restaurantId,
      branchId,
      entityType: 'shift',
      entityId: createdShift.id,
      operation: 'upsert',
      payload: createdShift,
    })

    return createdShift
  })

  return NextResponse.json({ shift, calculatedWage }, { status: 201 })
}

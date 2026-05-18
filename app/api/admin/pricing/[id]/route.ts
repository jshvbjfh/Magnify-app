import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export async function PATCH() {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json({ error: 'PricingPlan model removed' }, { status: 410 })
}

export async function DELETE() {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json({ error: 'PricingPlan model removed' }, { status: 410 })
}

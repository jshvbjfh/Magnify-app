import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json([])
}

export async function POST() {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json({ error: 'PricingPlan model removed' }, { status: 410 })
}

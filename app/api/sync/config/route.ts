import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = session.user as any
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const targetUrl = String(process.env.OWNER_SYNC_TARGET_URL ?? '').trim()
  const email = String(process.env.OWNER_SYNC_EMAIL ?? '').trim().toLowerCase()
  const usesSharedSecret = Boolean(String(process.env.OWNER_SYNC_SHARED_SECRET ?? '').trim())
  const hasPassword = Boolean(String(process.env.OWNER_SYNC_PASSWORD ?? '').trim())

  return NextResponse.json({
    configured: Boolean(targetUrl && email && (usesSharedSecret || hasPassword)),
    targetUrl,
    email,
    usesSharedSecret,
  })
}
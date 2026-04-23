import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getCanonicalCloudAppUrl } from '@/lib/cloudAuthBridge'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = session.user as any
  if (!['admin', 'waiter', 'kitchen'].includes(String(user.role))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const targetUrl = String(process.env.OWNER_SYNC_TARGET_URL ?? getCanonicalCloudAppUrl() ?? '').trim()
  const sessionEmail = typeof session.user.email === 'string' ? session.user.email.trim().toLowerCase() : ''
  const configuredOwnerEmail = String(process.env.OWNER_SYNC_EMAIL ?? '').trim().toLowerCase()
  const usesSharedSecret = Boolean(String(process.env.OWNER_SYNC_SHARED_SECRET ?? '').trim())
  const hasPassword = Boolean(String(process.env.OWNER_SYNC_PASSWORD ?? '').trim())
  const email = usesSharedSecret
    ? (configuredOwnerEmail || sessionEmail)
    : (configuredOwnerEmail || sessionEmail)

  return NextResponse.json({
    configured: Boolean(targetUrl && email && (usesSharedSecret || hasPassword)),
    targetUrl,
    email,
    usesSharedSecret,
  })
}
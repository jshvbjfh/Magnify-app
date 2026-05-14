import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import fs from 'fs'
import path from 'path'

/**
 * Desktop-only endpoint for managing the OWNER_SYNC_SHARED_SECRET post-install.
 *
 * The secret is never bundled in the shipped package. Instead, the admin enters it
 * once in Settings › Owner cloud sync. This endpoint persists it to
 * userData/sync.secret (mode 0o600) and also sets process.env so the running
 * server picks it up immediately without a restart.
 *
 * MAGNIFY_USER_DATA_DIR is only set by electron/main.js, so this endpoint is a
 * no-op (returns 404) in web/Vercel deployments.
 */

function getUserDataDir(): string | null {
  const dir = String(process.env.MAGNIFY_USER_DATA_DIR ?? '').trim()
  return dir || null
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role?: string }
  if (!['admin', 'owner'].includes(String(user.role ?? ''))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const userDataDir = getUserDataDir()
  if (!userDataDir) {
    return NextResponse.json({ error: 'Not available on this deployment' }, { status: 404 })
  }

  const configured = Boolean(String(process.env.OWNER_SYNC_SHARED_SECRET ?? '').trim())
  return NextResponse.json({ configured })
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role?: string }
  if (!['admin', 'owner'].includes(String(user.role ?? ''))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const userDataDir = getUserDataDir()
  if (!userDataDir) {
    return NextResponse.json({ error: 'Not available on this deployment' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const secret = String((body as Record<string, unknown>)?.secret ?? '').trim()
  if (!secret) {
    return NextResponse.json({ error: 'secret is required' }, { status: 400 })
  }
  if (secret.length > 512) {
    return NextResponse.json({ error: 'secret is too long (max 512 characters)' }, { status: 400 })
  }

  const syncSecretPath = path.join(userDataDir, 'sync.secret')
  try {
    fs.mkdirSync(userDataDir, { recursive: true })
    fs.writeFileSync(syncSecretPath, secret, { encoding: 'utf8', mode: 0o600 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Failed to write sync secret: ${message}` }, { status: 500 })
  }

  // Apply immediately to the running process so /api/sync/config picks it up
  // without requiring a restart. The file ensures it persists across restarts.
  process.env.OWNER_SYNC_SHARED_SECRET = secret

  return NextResponse.json({ ok: true, configured: true })
}

export async function DELETE() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const user = session.user as { role?: string }
  if (!['admin', 'owner'].includes(String(user.role ?? ''))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const userDataDir = getUserDataDir()
  if (!userDataDir) {
    return NextResponse.json({ error: 'Not available on this deployment' }, { status: 404 })
  }

  const syncSecretPath = path.join(userDataDir, 'sync.secret')
  try {
    if (fs.existsSync(syncSecretPath)) {
      fs.unlinkSync(syncSecretPath)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Failed to remove sync secret: ${message}` }, { status: 500 })
  }

  delete process.env.OWNER_SYNC_SHARED_SECRET
  return NextResponse.json({ ok: true, configured: false })
}

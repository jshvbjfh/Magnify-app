import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

// Chat history is stored on-device (localStorage) — this endpoint is intentionally a no-op.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  void req
  return NextResponse.json({ messages: [] })
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json()
  const { role, content } = body
  if (!role || !content) return NextResponse.json({ error: 'Role and content are required' }, { status: 400 })
  if (role !== 'user' && role !== 'assistant') return NextResponse.json({ error: 'Role must be "user" or "assistant"' }, { status: 400 })
  return NextResponse.json({ message: { id: 'noop', role, content, timestamp: new Date().toISOString() } })
}

export async function DELETE() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ error: 'Chat deletion is disabled.' }, { status: 403 })
}

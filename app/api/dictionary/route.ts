import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'

// CustomDictionary model was removed — stubs preserve the API shape
async function requireSession() {
  const session = await getServerSession(authOptions)
  if (!session?.user) throw new Error('Unauthorized')
  return session
}

export async function GET() {
  try {
    await requireSession()
    return NextResponse.json({ entries: [] })
  } catch (e: any) {
    return new NextResponse(e?.message || 'Unauthorized', { status: 401 })
  }
}

export async function POST(req: Request) {
  try {
    await requireSession()
    void req
    return NextResponse.json({ entry: null }, { status: 410 })
  } catch (e: any) {
    const msg = e?.message || 'Error'
    return new NextResponse(msg, { status: msg === 'Unauthorized' ? 401 : 500 })
  }
}

export async function PATCH(req: Request) {
  try {
    await requireSession()
    void req
    return NextResponse.json({ entry: null }, { status: 410 })
  } catch (e: any) {
    const msg = e?.message || 'Error'
    return new NextResponse(msg, { status: msg === 'Unauthorized' ? 401 : 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    await requireSession()
    void req
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    const msg = e?.message || 'Error'
    return new NextResponse(msg, { status: msg === 'Unauthorized' ? 401 : 500 })
  }
}

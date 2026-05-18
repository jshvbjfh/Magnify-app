import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json({ error: 'AI marketing not available' }, { status: 501 })
}

export async function GET() {
  return NextResponse.json({ error: 'AI marketing not available' }, { status: 501 })
}

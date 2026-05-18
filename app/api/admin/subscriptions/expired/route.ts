import { NextResponse } from 'next/server'

// Subscription model removed from schema.
export async function GET() {
  return NextResponse.json({ error: 'Subscription management not available' }, { status: 501 })
}

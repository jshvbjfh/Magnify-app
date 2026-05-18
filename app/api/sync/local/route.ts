import { NextResponse } from 'next/server'

// Local sync protocol was rebuilt. syncRestaurantId, syncToken, and
// RestaurantSyncState/Batch/Event models were removed in the schema refactor.
export async function GET() {
  return NextResponse.json({ error: 'Local sync protocol deprecated' }, { status: 410 })
}

export async function POST() {
  return NextResponse.json({ error: 'Local sync protocol deprecated' }, { status: 410 })
}

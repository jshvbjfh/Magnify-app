import { NextResponse } from 'next/server'

// This route provisioned User accounts via syncRestaurantId+syncToken identity.
// Both fields were removed from the Restaurant model in the schema refactor.
// Account creation now happens through the standard restaurant admin UI.
export async function POST() {
  return NextResponse.json(
    { error: 'Sync-based account provisioning is no longer supported. Create accounts through the restaurant admin panel.' },
    { status: 501 },
  )
}

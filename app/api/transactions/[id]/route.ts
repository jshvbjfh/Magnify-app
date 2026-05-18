import { NextResponse } from 'next/server'

export async function PATCH() {
  return NextResponse.json({ error: 'Transaction ledger has been replaced by journal entries' }, { status: 410 })
}

export async function DELETE() {
  return NextResponse.json({ error: 'Transaction ledger has been replaced by journal entries' }, { status: 410 })
}

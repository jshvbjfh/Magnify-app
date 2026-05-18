import { NextResponse } from 'next/server'

const gone = () => NextResponse.json({ error: 'Upload feature has been removed' }, { status: 410 })

export async function GET() { return gone() }
export async function POST() { return gone() }

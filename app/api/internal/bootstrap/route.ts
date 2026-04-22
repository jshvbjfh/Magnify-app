import { NextResponse } from 'next/server'

import { ensureAppBootstrap } from '@/lib/bootstrap'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const expectedSecret = String(process.env.MAGNIFY_INTERNAL_BOOTSTRAP_SECRET || '').trim()
    const providedSecret = req.headers.get('x-bootstrap-secret')?.trim() ?? ''

    if (!expectedSecret || providedSecret !== expectedSecret) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const result = await ensureAppBootstrap(prisma, {
      migrationState: 'ready',
      deviceId: req.headers.get('x-branch-device-id'),
      appVersion: req.headers.get('x-app-version'),
      restaurantId: req.headers.get('x-restaurant-id'),
    })

    return NextResponse.json(result, { status: result.ok ? 200 : 503 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal bootstrap failed'
    return NextResponse.json({ error: message, lastError: message }, { status: 500 })
  }
}
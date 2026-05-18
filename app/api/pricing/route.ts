import { NextResponse } from 'next/server'

import { APP_SCHEMA_STATE_KEY, APP_SCHEMA_VERSION } from '@/lib/bootstrapConfig'
import { ensureAppBootstrap, getPricingCatalog } from '@/lib/bootstrap'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET() {
  const state = await prisma.appSchemaState.findUnique({ where: { key: APP_SCHEMA_STATE_KEY } })
  if (!state || state.schemaVersion < APP_SCHEMA_VERSION) {
    await ensureAppBootstrap(prisma)
  }

  return NextResponse.json(await getPricingCatalog(prisma))
}

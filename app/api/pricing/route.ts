import { NextResponse } from 'next/server'

import { APP_SCHEMA_STATE_KEY, BOOTSTRAP_VERSION } from '@/lib/bootstrapConfig'
import { ensureAppBootstrap, getPricingCatalog } from '@/lib/bootstrap'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET() {
  const state = await prisma.appSchemaState.findUnique({ where: { key: APP_SCHEMA_STATE_KEY } })
  if (!state || state.bootstrapVersion < BOOTSTRAP_VERSION || state.migrationState !== 'ready') {
    await ensureAppBootstrap(prisma, { migrationState: 'ready' })
  }

  return NextResponse.json(await getPricingCatalog(prisma))
}

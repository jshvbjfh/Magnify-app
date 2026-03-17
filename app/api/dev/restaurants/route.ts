import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '30')

function getLicenseStatus(r: {
  trialStartAt: Date
  licenseExpiry: Date | null
  licenseActive: boolean
}) {
  if (!r.licenseActive) return 'suspended'
  const now = new Date()
  if (r.licenseExpiry && r.licenseExpiry > now) return 'active'
  const trialEnd = new Date(r.trialStartAt.getTime() + TRIAL_DAYS * 86400000)
  if (now <= trialEnd) return 'trial'
  return 'expired'
}

function checkKey(req: Request) {
  const url = new URL(req.url)
  const key = url.searchParams.get('key') || req.headers.get('x-dev-key')
  if (key !== process.env.DEV_ADMIN_KEY) throw new Error('Unauthorized')
}

export async function GET(req: Request) {
  try {
    checkKey(req)
    const restaurants = await prisma.restaurant.findMany({
      include: { owner: { select: { name: true, email: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    })
    const TRIAL_MS = TRIAL_DAYS * 86400000
    return NextResponse.json(restaurants.map(r => {
      const row = r as typeof r & { trialStartAt: Date; licenseExpiry: Date | null; licenseActive: boolean }
      const status = getLicenseStatus(row)
      const trialEnd = new Date(row.trialStartAt.getTime() + TRIAL_MS)
      const daysLeft = status === 'trial'
        ? Math.ceil((trialEnd.getTime() - Date.now()) / 86400000)
        : status === 'active'
        ? Math.ceil((row.licenseExpiry!.getTime() - Date.now()) / 86400000)
        : 0
      return {
        id: r.id,
        name: r.name,
        ownerName: r.owner.name,
        ownerEmail: r.owner.email,
        joinedAt: r.owner.createdAt,
        trialStartAt: row.trialStartAt,
        licenseExpiry: row.licenseExpiry,
        licenseActive: row.licenseActive,
        status,
        daysLeft,
      }
    }))
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.message === 'Unauthorized' ? 401 : 500 })
  }
}

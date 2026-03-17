export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const snapshotType = `ai_daily_insight_${session.user.id}`
		const latest = await prisma.financialStatement.findFirst({
			where: { type: snapshotType },
			orderBy: { createdAt: 'desc' }
		})

		if (!latest) {
			return NextResponse.json({ snapshot: null })
		}

		let parsed: any = null
		try {
			parsed = JSON.parse(latest.data)
		} catch {
			parsed = null
		}

		return NextResponse.json({
			snapshot: parsed,
			storedAt: latest.createdAt,
			periodStart: latest.periodStart,
			periodEnd: latest.periodEnd
		})
	} catch (error: any) {
		console.error('AI snapshot fetch error:', error)
		return NextResponse.json({ error: error.message || 'Failed to fetch AI snapshot' }, { status: 500 })
	}
}

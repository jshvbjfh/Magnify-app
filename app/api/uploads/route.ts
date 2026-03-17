import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

async function requireUserId() {
	const session = await getServerSession(authOptions)
	const userId = session?.user?.id
	if (!userId) throw new Error('Unauthorized')
	return userId
}

export async function GET() {
	try {
		const userId = await requireUserId()

		const uploads = await prisma.upload.findMany({
			where: { userId },
			orderBy: { createdAt: 'desc' },
			take: 50,
			include: {
				_count: {
					select: { transactions: true }
				}
			}
		})

		return NextResponse.json({
			uploads: uploads.map((u) => ({
				id: u.id,
				fileName: u.fileName,
				filePath: u.filePath,
				status: u.status,
				errorMessage: u.errorMessage,
				createdAt: u.createdAt.toISOString(),
				updatedAt: u.updatedAt.toISOString(),
				transactionCount: u._count.transactions
			}))
		})
	} catch (e: any) {
		return new NextResponse(e?.message || 'Unauthorized', { status: 401 })
	}
}

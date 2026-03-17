import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

async function requireSession() {
	const session = await getServerSession(authOptions)
	if (!session?.user) throw new Error('Unauthorized')
	return session
}

export async function GET() {
	try {
		await requireSession()
		const entries = await prisma.customDictionary.findMany({
			orderBy: { createdAt: 'asc' }
		})
		return NextResponse.json({ entries })
	} catch (e: any) {
		return new NextResponse(e?.message || 'Unauthorized', { status: 401 })
	}
}

export async function POST(req: Request) {
	try {
		await requireSession()
		const body = await req.json()
		const kinyarwandaWord = String(body.kinyarwandaWord || '').trim()
		const englishMeaning = String(body.englishMeaning || '').trim()
		const context = String(body.context || '').trim()
		if (!kinyarwandaWord || !englishMeaning) {
			return new NextResponse('Missing fields', { status: 400 })
		}

		const entry = await prisma.customDictionary.create({
			data: {
				kinyarwandaWord,
				englishMeaning,
				context: context || null
			}
		})
		return NextResponse.json({ entry })
	} catch (e: any) {
		const msg = e?.message || 'Error'
		const status = msg === 'Unauthorized' ? 401 : 500
		return new NextResponse(msg, { status })
	}
}

export async function PATCH(req: Request) {
	try {
		await requireSession()
		const body = await req.json()
		const id = String(body.id || '').trim()
		const kinyarwandaWord = String(body.kinyarwandaWord || '').trim()
		const englishMeaning = String(body.englishMeaning || '').trim()
		const context = String(body.context || '').trim()
		
		// Be specific about what's missing
		const missingFields = []
		if (!id) missingFields.push('id')
		if (!kinyarwandaWord) missingFields.push('kinyarwandaWord')
		if (!englishMeaning) missingFields.push('englishMeaning')
		
		if (missingFields.length > 0) {
			return new NextResponse(`Missing required fields: ${missingFields.join(', ')}`, { status: 400 })
		}

		const entry = await prisma.customDictionary.update({
			where: { id },
			data: {
				kinyarwandaWord,
				englishMeaning,
				context: context || null
			}
		})
		return NextResponse.json({ entry })
	} catch (e: any) {
		const msg = e?.message || 'Error'
		const status = msg === 'Unauthorized' ? 401 : 500
		return new NextResponse(msg, { status })
	}
}

export async function DELETE(req: Request) {
	try {
		await requireSession()
		const url = new URL(req.url)
		const id = url.searchParams.get('id')
		if (!id) return new NextResponse('Missing id', { status: 400 })

		await prisma.customDictionary.delete({ where: { id } })
		return NextResponse.json({ ok: true })
	} catch (e: any) {
		const msg = e?.message || 'Error'
		const status = msg === 'Unauthorized' ? 401 : 500
		return new NextResponse(msg, { status })
	}
}

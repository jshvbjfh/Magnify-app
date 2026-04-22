import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import fs from 'fs'
import path from 'path'
import { authOptions } from '@/lib/auth'
import { getGeminiApiKeys, getGeminiDiagnostics } from '@/lib/openai'

async function requireAdminSession() {
	const session = await getServerSession(authOptions)
	if (!session?.user?.id) {
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
	}

	const user = session.user as any
	if (user.role !== 'admin') {
		return NextResponse.json({ error: 'Admin only' }, { status: 403 })
	}

	return null
}

export async function GET() {
	const authError = await requireAdminSession()
	if (authError) return authError

	const hasAiServiceKey = getGeminiApiKeys().length > 0
	return NextResponse.json({
		hasAiServiceKey,
		hasGeminiKey: hasAiServiceKey,
		gemini: getGeminiDiagnostics()
	})
}

export async function POST(req: NextRequest) {
	const authError = await requireAdminSession()
	if (authError) return authError

	try {
		const { geminiApiKey } = await req.json()
		if (!geminiApiKey || typeof geminiApiKey !== 'string') {
			return NextResponse.json({ error: 'Invalid API key' }, { status: 400 })
		}

		const trimmed = geminiApiKey.trim()

		// Update process.env immediately (no restart needed for this session)
		process.env.GEMINI_API_KEY = trimmed

		// Persist to .env file
		const envPath = path.join(process.cwd(), '.env')
		let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''

		if (/^GEMINI_API_KEY=/m.test(envContent)) {
			envContent = envContent.replace(/^GEMINI_API_KEY=.*/m, `GEMINI_API_KEY="${trimmed}"`)
		} else {
			envContent = envContent.trimEnd() + `\nGEMINI_API_KEY="${trimmed}"\n`
		}

		fs.writeFileSync(envPath, envContent, 'utf8')

		return NextResponse.json({ ok: true, gemini: getGeminiDiagnostics() })
	} catch (e: any) {
		return NextResponse.json({ error: e.message }, { status: 500 })
	}
}

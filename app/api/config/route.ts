import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'

export async function GET() {
	const hasAiServiceKey = Boolean(process.env.GEMINI_API_KEY)
	return NextResponse.json({
		hasAiServiceKey,
		hasGeminiKey: hasAiServiceKey
	})
}

export async function POST(req: NextRequest) {
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

		return NextResponse.json({ ok: true })
	} catch (e: any) {
		return NextResponse.json({ error: e.message }, { status: 500 })
	}
}

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function POST(req: NextRequest) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const formData = await req.formData()
		const file = formData.get('file') as File
		
		if (!file) {
			return NextResponse.json({ error: 'No file provided' }, { status: 400 })
		}

		// Validate file type
		if (!file.type.startsWith('image/')) {
			return NextResponse.json({ error: 'File must be an image' }, { status: 400 })
		}

		// Validate file size (max 10MB)
		if (file.size > 10 * 1024 * 1024) {
			return NextResponse.json({ error: 'File size must be less than 10MB' }, { status: 400 })
		}

		// Create unique filename
		const timestamp = Date.now()
		const randomStr = Math.random().toString(36).substring(2, 15)
		const ext = path.extname(file.name)
		const filename = `chat-${timestamp}-${randomStr}${ext}`

		// Create uploads directory if it doesn't exist
		const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'chat')
		await mkdir(uploadDir, { recursive: true })

		// Save file
		const filePath = path.join(uploadDir, filename)
		const bytes = await file.arrayBuffer()
		const buffer = Buffer.from(bytes)
		await writeFile(filePath, buffer)

		// Return web-accessible path
		const webPath = `/uploads/chat/${filename}`

		return NextResponse.json({ 
			ok: true,
			path: webPath,
			filename 
		})
	} catch (e: any) {
		console.error('Upload error:', e)
		return NextResponse.json({ error: e.message || 'Upload failed' }, { status: 500 })
	}
}

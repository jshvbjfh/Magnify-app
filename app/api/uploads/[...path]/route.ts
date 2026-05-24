import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params

  // Block path traversal
  const relative = segments.join('/')
  if (relative.includes('..')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const filePath = path.join(process.cwd(), 'public', 'uploads', relative)

  try {
    const bytes = await readFile(filePath)
    const ext = path.extname(relative).toLowerCase()
    const contentType = MIME[ext] ?? 'application/octet-stream'
    return new Response(bytes, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}

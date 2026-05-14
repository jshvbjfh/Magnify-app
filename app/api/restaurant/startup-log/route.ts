import fs from 'fs/promises'
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STARTUP_LOG_TAIL_BYTES = 64 * 1024

async function readStartupLogTail(filePath: string) {
  const handle = await fs.open(filePath, 'r')

  try {
    const stat = await handle.stat()
    const sizeBytes = Number(stat.size ?? 0)
    const start = Math.max(0, sizeBytes - STARTUP_LOG_TAIL_BYTES)
    const length = Math.max(0, sizeBytes - start)
    const buffer = Buffer.alloc(length)

    if (length > 0) {
      await handle.read(buffer, 0, length, start)
    }

    let content = buffer.toString('utf8')
    const truncated = start > 0

    if (truncated) {
      const firstNewline = content.indexOf('\n')
      if (firstNewline >= 0) {
        content = content.slice(firstNewline + 1)
      }
      content = `[... earlier startup log lines omitted ...]\n${content}`
    }

    return {
      content: content.trimEnd(),
      sizeBytes,
      truncated,
      updatedAt: stat.mtime.toISOString(),
    }
  } finally {
    await handle.close()
  }
}

function noStoreHeaders(extraHeaders?: HeadersInit) {
  return {
    'Cache-Control': 'no-store, max-age=0',
    ...extraHeaders,
  }
}

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders() })
  }

  const role = (session.user as any)?.role
  if (role !== 'admin' && role !== 'owner') {
    return NextResponse.json({ error: 'Admin or owner only' }, { status: 403, headers: noStoreHeaders() })
  }

  const startupLogPath = String(process.env.MAGNIFY_STARTUP_LOG_PATH || '').trim()
  if (!startupLogPath) {
    return NextResponse.json({
      available: false,
      path: null,
      updatedAt: null,
      sizeBytes: 0,
      truncated: false,
      content: '',
      message: 'Startup log is only available from the Magnify desktop app on this device.',
    }, { headers: noStoreHeaders() })
  }

  try {
    await fs.access(startupLogPath)
  } catch {
    return NextResponse.json({
      available: false,
      path: startupLogPath,
      updatedAt: null,
      sizeBytes: 0,
      truncated: false,
      content: '',
      message: 'Startup log has not been created on this device yet. Restart the desktop app once and refresh this panel.',
    }, { headers: noStoreHeaders() })
  }

  if (request.nextUrl.searchParams.get('download') === '1') {
    const fileContents = await fs.readFile(startupLogPath, 'utf8')
    return new NextResponse(fileContents, {
      headers: noStoreHeaders({
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="startup.log"',
      }),
    })
  }

  const startupLog = await readStartupLogTail(startupLogPath)
  return NextResponse.json({
    available: true,
    path: startupLogPath,
    updatedAt: startupLog.updatedAt,
    sizeBytes: startupLog.sizeBytes,
    truncated: startupLog.truncated,
    content: startupLog.content,
    message: startupLog.truncated
      ? 'Showing the latest startup log tail. Download the full file if you need older lines.'
      : null,
  }, { headers: noStoreHeaders() })
}
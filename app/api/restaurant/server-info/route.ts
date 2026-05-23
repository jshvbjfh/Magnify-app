import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import os from 'os'
import { authOptions } from '@/lib/auth'

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

function resolveAccessibleOrigin(req: Request) {
  const url = new URL(req.url)
  const forwardedHost = req.headers.get('x-forwarded-host')
  const host = forwardedHost ?? req.headers.get('host') ?? url.host
  if (!host) return null

  const hostname = host.split(':')[0]?.trim().toLowerCase()
  if (!hostname || isLoopbackHost(hostname)) return null

  const protocol = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(/:$/, '')
  return `${protocol}://${host}`
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = session.user as any
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const publicOrigin = resolveAccessibleOrigin(req)
  if (publicOrigin) {
    return NextResponse.json({ waiterUrl: publicOrigin, localIP: null, port: null, accessMode: 'public' })
  }

  const nets = os.networkInterfaces()
  let localIP = 'localhost'

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        localIP = net.address
        break
      }
    }
    if (localIP !== 'localhost') break
  }

  const port = process.env.PORT || '3001'
  const waiterUrl = `http://${localIP}:${port}`

  return NextResponse.json({ waiterUrl, localIP, port, accessMode: 'lan' })
}

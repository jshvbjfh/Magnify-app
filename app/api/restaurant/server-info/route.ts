import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import os from 'os'
import { authOptions } from '@/lib/auth'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = session.user as any
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

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

  return NextResponse.json({ waiterUrl, localIP, port })
}

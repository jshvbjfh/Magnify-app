import { NextResponse } from 'next/server'
import os from 'os'

export async function GET() {
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

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

const NO_STORE_CACHE_CONTROL = 'no-store, no-cache, must-revalidate, proxy-revalidate'

export function middleware(_request: NextRequest) {
  const response = NextResponse.next()
  response.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL)
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  response.headers.set('Surrogate-Control', 'no-store')
  return response
}

export const config = {
  matcher: [
    '/api/restaurant/:path*',
    '/api/transactions',
    '/api/user/profile',
  ],
}
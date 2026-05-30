import { NextResponse } from 'next/server'

/**
 * Wraps a successful GET response with browser-level cache headers so the
 * manager portal feels instant on repeat visits.
 *
 * private            – only the user's own browser caches it (never Vercel CDN)
 * max-age            – browser returns stored copy without a network call
 * stale-while-revalidate – after max-age, still returns instantly but fetches
 *                     fresh data in the background and updates on next render
 */
export function cached(data: unknown, maxAge = 30, swr = 300): NextResponse {
  return NextResponse.json(data, {
    headers: {
      'Cache-Control': `private, max-age=${maxAge}, stale-while-revalidate=${swr}`,
    },
  })
}

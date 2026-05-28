import { NextResponse } from 'next/server'

/**
 * Wraps a JSON response with Cache-Control headers.
 * @param data              The response body (serialised as JSON).
 * @param maxAge            Seconds the client may serve the cached response (default 30).
 * @param staleWhileRevalidate  Extra seconds the client may serve stale data while
 *                          revalidating in the background (default 60).
 */
export function cached<T>(data: T, maxAge = 30, staleWhileRevalidate = 60): NextResponse {
  return NextResponse.json(data, {
    headers: {
      'Cache-Control': `private, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`,
      Vary: 'Cookie',
    },
  })
}

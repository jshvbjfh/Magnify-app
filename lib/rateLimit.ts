/**
 * Minimal in-process sliding-window rate limiter.
 *
 * Tracks request timestamps per key in a Map. Suitable for single-instance
 * deployments (Electron) and Vercel (each instance has its own counter; limits
 * are per-instance which is acceptable for our traffic levels).
 *
 * Usage:
 *   const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })
 *   const result = limiter.check('ip:1.2.3.4')
 *   if (!result.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
 */

type RateLimiterOptions = {
  /** Rolling window in milliseconds */
  windowMs: number
  /** Maximum requests per window */
  max: number
}

type RateLimitResult = {
  allowed: boolean
  remaining: number
  resetAt: number
}

export function createRateLimiter(options: RateLimiterOptions) {
  const { windowMs, max } = options
  // Map from key → array of request timestamps (ms)
  const store = new Map<string, number[]>()

  // Purge keys whose entire window has expired (prevents unbounded memory growth)
  function prune() {
    const now = Date.now()
    for (const [key, timestamps] of store) {
      const fresh = timestamps.filter((t) => now - t < windowMs)
      if (fresh.length === 0) {
        store.delete(key)
      } else {
        store.set(key, fresh)
      }
    }
  }

  // Prune every full window cycle, lazily on check calls
  let lastPrune = Date.now()

  return {
    check(key: string): RateLimitResult {
      const now = Date.now()

      if (now - lastPrune > windowMs) {
        prune()
        lastPrune = now
      }

      const timestamps = (store.get(key) ?? []).filter((t) => now - t < windowMs)
      const allowed = timestamps.length < max

      if (allowed) {
        timestamps.push(now)
        store.set(key, timestamps)
      }

      const oldest = timestamps[0] ?? now
      return {
        allowed,
        remaining: Math.max(0, max - timestamps.length),
        resetAt: oldest + windowMs,
      }
    },
  }
}

/**
 * Extract a best-effort client key from a Next.js Request for rate-limiting.
 * Uses x-forwarded-for (set by Vercel/proxies), falling back to a static key
 * so Electron (no proxy) is treated as one client.
 */
export function getRateLimitKey(req: Request, prefix = ''): string {
  const xff = req.headers.get('x-forwarded-for')
  const ip = xff ? xff.split(',')[0].trim() : 'local'
  return prefix ? `${prefix}:${ip}` : ip
}

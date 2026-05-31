const RETRY_DELAYS = [1500, 2000, 2000] // ms between attempts 1→2, 2→3, 3→4

/**
 * Wraps fetch with three-tier cold-start recovery:
 *   Tier 1 — first failure: silent retry after 1.5s (user sees nothing)
 *   Tier 2 — second failure: call onConnecting(), retry every 2s
 *   Tier 3 — after maxAttempts: throw so caller can show a real error
 *
 * A 503 response is treated the same as a network failure — it means
 * the database is waking up, not that the request was invalid.
 */
export async function fetchWithWakeup(
  url: string,
  options: RequestInit,
  onConnecting: () => void,
  maxAttempts = 4,
): Promise<Response> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, options)
      if (res.status !== 503) return res
      throw new Error('503')
    } catch {
      if (attempt >= maxAttempts) throw new Error('Could not connect.')
      if (attempt === 2) onConnecting()
      await new Promise<void>(r => setTimeout(r, RETRY_DELAYS[attempt - 1] ?? 2000))
    }
  }
  throw new Error('Could not connect.')
}

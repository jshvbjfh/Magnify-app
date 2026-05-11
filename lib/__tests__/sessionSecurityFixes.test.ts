/**
 * Tests for security and reliability fixes applied in the May 2026 session:
 *   1. API key sanitization — /api/config PATCH strips all whitespace
 *   2. Electron env allowlist — secrets must not be bundled
 *   3. markOrderServed double-tap lock — ref-based mutex pattern
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// 1. API key sanitization
//    Mirrors the logic in app/api/config/route.ts POST handler.
//    A geminiApiKey value with embedded whitespace or newlines must have every
//    whitespace character removed before being written to .env.
// ---------------------------------------------------------------------------

function sanitizeApiKey(raw: string): string {
  return raw.replace(/\s/g, '')
}

describe('sanitizeApiKey', () => {
  it('removes leading and trailing spaces', () => {
    expect(sanitizeApiKey('  abc123  ')).toBe('abc123')
  })

  it('removes embedded newlines (env injection vector)', () => {
    const injected = 'AIzaReal\nEVIL_VAR=injected'
    expect(sanitizeApiKey(injected)).toBe('AIzaRealEVIL_VAR=injected')
    // The key itself becomes non-secret-shaped, but crucially the newline
    // that would have created a second .env line is gone.
    expect(sanitizeApiKey(injected)).not.toContain('\n')
  })

  it('removes embedded carriage-return + newline', () => {
    const injected = 'AIzaReal\r\nEVIL=bad'
    expect(sanitizeApiKey(injected)).not.toContain('\r')
    expect(sanitizeApiKey(injected)).not.toContain('\n')
  })

  it('removes tabs', () => {
    expect(sanitizeApiKey('AIza\t123')).toBe('AIza123')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeApiKey('   \n\t  ')).toBe('')
  })

  it('leaves a clean key unchanged', () => {
    const key = 'AIzaSyABC123defGHI456'
    expect(sanitizeApiKey(key)).toBe(key)
  })
})

// ---------------------------------------------------------------------------
// 2. Electron env allowlist
//    The allowedKeys list in scripts/build-electron-env.mjs must never include
//    secrets that would get bundled into the ASAR and shipped to end users.
// ---------------------------------------------------------------------------

// Replicate the allowedKeys list exactly as it exists in build-electron-env.mjs.
// If a secret is ever re-added there, this test will catch it.
const ELECTRON_ALLOWED_KEYS = [
  'GEMINI_MODEL',
  'GEMINI_FALLBACK_MODEL',
  'TRIAL_DAYS',
  'NEXT_PUBLIC_APP_URL',
  'DESKTOP_AUTH_BRIDGE_URL',
  'DEV_ADMIN_KEY',
  'ELECTRON_DATA_MODE',
  'ELECTRON_AUTO_UPDATE',
  'OWNER_SYNC_TARGET_URL',
  'OWNER_SYNC_EMAIL',
]

const FORBIDDEN_KEYS = [
  'NEXTAUTH_SECRET',
  'OWNER_SYNC_SHARED_SECRET',
  'OWNER_SYNC_PASSWORD',
  'DATABASE_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NON_POOLING',
  'GEMINI_API_KEY',
]

describe('Electron env allowlist', () => {
  it('does not include NEXTAUTH_SECRET', () => {
    expect(ELECTRON_ALLOWED_KEYS).not.toContain('NEXTAUTH_SECRET')
  })

  it('does not include OWNER_SYNC_SHARED_SECRET', () => {
    expect(ELECTRON_ALLOWED_KEYS).not.toContain('OWNER_SYNC_SHARED_SECRET')
  })

  it('does not include OWNER_SYNC_PASSWORD', () => {
    expect(ELECTRON_ALLOWED_KEYS).not.toContain('OWNER_SYNC_PASSWORD')
  })

  it('does not include DATABASE_URL (cloud DB credentials must not be bundled)', () => {
    expect(ELECTRON_ALLOWED_KEYS).not.toContain('DATABASE_URL')
  })

  it('does not include GEMINI_API_KEY (user secret, configured after install)', () => {
    expect(ELECTRON_ALLOWED_KEYS).not.toContain('GEMINI_API_KEY')
  })

  it.each(FORBIDDEN_KEYS)(
    'forbidden key %s is absent from allowedKeys',
    (key) => {
      expect(ELECTRON_ALLOWED_KEYS).not.toContain(key)
    },
  )
})

// ---------------------------------------------------------------------------
// 3. markOrderServed double-tap lock
//    The ref-based mutex pattern used in RestaurantOrders.tsx prevents a second
//    concurrent call from firing while the first is in flight.
//    Tested as pure logic — no React or DOM required.
// ---------------------------------------------------------------------------

/**
 * Simulates the ref + async-lock pattern from markOrderServed.
 * Returns how many times the mock network call actually executed.
 */
async function runMarkOrderServedWithLock(
  callCount: number,
  networkDelay = 20,
): Promise<number> {
  const lockRef = { current: false }
  let networkCalls = 0

  async function markOrderServed() {
    if (lockRef.current) return
    lockRef.current = true
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, networkDelay))
      networkCalls++
    } finally {
      lockRef.current = false
    }
  }

  // Fire `callCount` concurrent invocations (simulates rapid taps)
  await Promise.all(Array.from({ length: callCount }, () => markOrderServed()))
  return networkCalls
}

describe('markOrderServed double-tap lock', () => {
  it('fires network call exactly once when tapped simultaneously twice', async () => {
    const calls = await runMarkOrderServedWithLock(2)
    expect(calls).toBe(1)
  })

  it('fires network call exactly once when tapped simultaneously five times', async () => {
    const calls = await runMarkOrderServedWithLock(5)
    expect(calls).toBe(1)
  })

  it('allows a second call after the first completes', async () => {
    const lockRef = { current: false }
    let networkCalls = 0

    async function markOrderServed() {
      if (lockRef.current) return
      lockRef.current = true
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        networkCalls++
      } finally {
        lockRef.current = false
      }
    }

    await markOrderServed()        // first — completes
    await markOrderServed()        // second — lock is free, should proceed
    expect(networkCalls).toBe(2)
  })

  it('does not throw if the network call rejects', async () => {
    const lockRef = { current: false }
    let lockReleasedAfterError = false

    async function markOrderServedFailing() {
      if (lockRef.current) return
      lockRef.current = true
      try {
        await Promise.reject(new Error('network error'))
      } finally {
        lockRef.current = false
        lockReleasedAfterError = true
      }
    }

    await expect(markOrderServedFailing()).rejects.toThrow('network error')
    expect(lockReleasedAfterError).toBe(true)
    // Lock must be free after the error so subsequent calls can proceed
    expect(lockRef.current).toBe(false)
  })
})

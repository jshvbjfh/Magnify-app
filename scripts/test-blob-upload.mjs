/**
 * Test blob upload via API calls (no Electron GUI needed).
 * Usage: node scripts/test-blob-upload.mjs <password>
 */
import { createCanvas } from 'canvas'

const BASE = 'http://localhost:3002'
const EMAIL = 'nxtgentech250@gmail.com'
const PASSWORD = process.argv[2]

if (!PASSWORD) {
  console.error('Usage: node scripts/test-blob-upload.mjs <password>')
  process.exit(1)
}

// 1. Get CSRF token
console.log('1. Fetching CSRF token...')
const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
const { csrfToken } = await csrfRes.json()
const cookies = csrfRes.headers.getSetCookie?.() ?? []
console.log('   CSRF token:', csrfToken)

// 2. Sign in
console.log('2. Signing in...')
const signInBody = new URLSearchParams({
  email: EMAIL,
  password: PASSWORD,
  csrfToken,
  callbackUrl: BASE,
  json: 'true',
})
const signInRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Cookie: cookies.join('; '),
  },
  redirect: 'manual',
  body: signInBody.toString(),
})
const signInCookies = [
  ...cookies,
  ...(signInRes.headers.getSetCookie?.() ?? []),
]
console.log('   Status:', signInRes.status)

// 3. Check session
console.log('3. Checking session...')
const sessionRes = await fetch(`${BASE}/api/auth/session`, {
  headers: { Cookie: signInCookies.join('; ') },
})
const session = await sessionRes.json()
if (!session?.user) {
  console.error('   Not authenticated. Check password.')
  process.exit(1)
}
console.log('   Logged in as:', session.user.email)

// 4. Create a tiny test PNG in memory (1×1 red pixel)
console.log('4. Creating test image...')
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==',
  'base64'
)
const blob = new Blob([pngBytes], { type: 'image/png' })
const formData = new FormData()
formData.append('file', new File([blob], 'test.png', { type: 'image/png' }))

// 5. Call the upload endpoint
console.log('5. POSTing to /api/restaurant/qr-menu-image...')
const uploadRes = await fetch(`${BASE}/api/restaurant/qr-menu-image`, {
  method: 'POST',
  headers: { Cookie: signInCookies.join('; ') },
  body: formData,
})
const uploadJson = await uploadRes.json().catch(() => null)
console.log('   HTTP status:', uploadRes.status)
console.log('   Response:', JSON.stringify(uploadJson, null, 2))

if (uploadRes.ok) {
  console.log('\n✓ Upload succeeded! Blob URL:', uploadJson?.path)
} else {
  console.log('\n✗ Upload failed:', uploadJson?.error)
}

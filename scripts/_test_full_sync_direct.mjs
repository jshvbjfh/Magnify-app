const targetUrl = 'https://magnify-app-tau.vercel.app'
const email = 'high5ive@management.com'
const password = '50000000'

const res = await fetch(`${targetUrl}/api/sync`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-sync-email': email,
    'x-sync-password': password,
  },
  body: JSON.stringify({
    joinCode: 'MJJBQQ',
    batchId: 'debug-test-batch-001',
    payloadHash: 'debug-hash-001',
    deviceId: 'debug-test-device-001',
    branchId: null,
    branchIdentity: null,
    changes: [],
    pullCursors: [],
  }),
})

console.log('Status:', res.status)
const payload = await res.json().catch(() => null)
console.log('ok:', payload?.ok)
console.log('message:', payload?.message)
console.log('pullChanges count:', payload?.pullChanges?.length)
console.log('pullCursors:', JSON.stringify(payload?.pullCursors))
if (payload?.pullChanges?.[0]) console.log('sample pullChange:', JSON.stringify(payload.pullChanges[0], null, 2))
if (!payload?.ok) console.log('full payload:', JSON.stringify(payload, null, 2))

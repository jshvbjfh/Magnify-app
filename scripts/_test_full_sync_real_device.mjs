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
    batchId: 'debug-test-batch-002',
    payloadHash: 'debug-hash-002',
    deviceId: 'branch-device-c631c80b619d14eb40f4a75f',
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
if (!payload?.ok) console.log('full payload:', JSON.stringify(payload, null, 2))

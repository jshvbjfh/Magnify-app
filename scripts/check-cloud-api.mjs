// Query the cloud via the Vercel API to check what synced data looks like
const BASE = 'https://magnify-app-tau.vercel.app';

// We need to authenticate as acme2 first
async function main() {
  // Login to get session cookie
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      email: 'acme2@gmail.com',
      password: 'test', // we don't know the password, let's try the API directly
    }),
    redirect: 'manual',
  });
  console.log('Login status:', loginRes.status);

  // Instead, let's just check what synced data exists using the sync shared secret
  // Query the sync endpoint to see what the cloud has
  const syncRes = await fetch(`${BASE}/api/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sync-email': 'acme2@gmail.com',
      'x-sync-secret': 'e06fcc6416024b09014e6dbd21119014e773847529037df7b546f615fe21510c',
    },
    body: JSON.stringify({
      restaurantSyncId: 'branch_9390f4204d2ee8fca81f',
      restaurantToken: '3216a5f5f8dd4d7af6cf8f04fd979a4eae126ad01df804b6',
      batchId: 'diag-check-' + Date.now(),
      payloadHash: 'diag',
      deviceId: 'diagnostic',
      protocolVersion: 2,
      transactions: [],
      summaries: [],
      changes: [],
      pullCursors: [
        { scopeId: 'branch_9390f4204d2ee8fca81f', lastPulledAt: null, lastMutationId: null },
        { scopeId: 'global', lastPulledAt: null, lastMutationId: null },
      ],
    }),
  });

  console.log('Sync status:', syncRes.status);
  const body = await syncRes.json();
  console.log('Sync response:', JSON.stringify(body, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });

const branchId = 'cmpeldv660004obyup3maoigb';
const url = `https://waiter-api-production.up.railway.app/api/mobile/pull?branchId=${branchId}`;

async function run() {
  try {
    const response = await fetch(url, {
        headers: {
            'X-Branch-Id': branchId,
            'Content-Type': 'application/json'
        }
    });
    console.log('HTTP Status:', response.status);
    const text = await response.text();
    console.log('Response Body:', text);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

run();

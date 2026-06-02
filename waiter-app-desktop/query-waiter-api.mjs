const branchId = 'cmpeldv660004obyup3maoigb';
const url = `https://waiter-api-production.up.railway.app/api/mobile/pull?branchId=${branchId}`;

async function run() {
  try {
    const response = await fetch(url);
    console.log('HTTP Status:', response.status);
    const text = await response.text();
    console.log('Response Body:', text);
    try {
      const data = JSON.parse(text);
      if (data.dishes) {
        console.log('Dishes count:', data.dishes.length);
        console.log('Sample dishes:', data.dishes.slice(0, 3).map(d => d.name).join(', '));
      } else {
        console.log('No dishes found');
      }

      if (data.tables) {
        console.log('Tables count:', data.tables.length);
        console.log('Sample tables:', data.tables.slice(0, 3).map(t => t.name).join(', '));
      } else {
        console.log('No tables found');
      }
    } catch (e) {
      console.log('Response is not JSON');
    }
  } catch (error) {
    console.error('Error fetching data:', error.message);
  }
}

run();

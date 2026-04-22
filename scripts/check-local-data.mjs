import Database from 'better-sqlite3';

const dbPath = 'C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db';
const db = new Database(dbPath, { readonly: true });

// Check Acme2's restaurant
const restId = 'cmnqpkxyc000abmmlty8ftk04';
const ownerId = 'cmnqpkxw60008bmmlb3ealvp3';

console.log('=== Daily Summaries ===');
const summaries = db.prepare(`SELECT * FROM daily_summaries WHERE restaurantId = ?`).all(restId);
console.log('Count:', summaries.length);
for (const s of summaries) console.log(JSON.stringify(s));

console.log('\n=== Transactions by date for Acme2 ===');
const txns = db.prepare(`
  SELECT t.id, t.type, t.amount, t.description, t.date, t.createdAt, t.synced, t.sourceKind, t.authoritativeForRevenue, t.pairId,
    c.type as catType, c.name as catName
  FROM transactions t
  LEFT JOIN categories c ON t.categoryId = c.id
  WHERE t.restaurantId = ?
  ORDER BY t.date DESC
`).all(restId);
console.log('Count:', txns.length);
for (const t of txns) console.log(JSON.stringify(t));

console.log('\n=== Dish Sales for Acme2 ===');
const sales = db.prepare(`SELECT * FROM dish_sales WHERE restaurantId = ?`).all(restId);
console.log('Count:', sales.length);
for (const s of sales) {
  console.log(JSON.stringify({ id: s.id, saleDate: new Date(s.saleDate).toISOString(), totalSaleAmount: s.totalSaleAmount, calculatedFoodCost: s.calculatedFoodCost, dishId: s.dishId }));
}

// What does the desktop consider revenue for Apr 9?
console.log('\n=== Apr 9 revenue calculation ===');
const apr9Start = new Date('2026-04-09T00:00:00').getTime();
const apr9End = new Date('2026-04-09T23:59:59.999').getTime();

const apr9Sales = db.prepare(`SELECT SUM(totalSaleAmount) as total FROM dish_sales WHERE restaurantId = ? AND saleDate >= ? AND saleDate <= ?`).get(restId, apr9Start, apr9End);
console.log('DishSale revenue Apr 9:', apr9Sales?.total);

const apr9IncomeTxns = db.prepare(`
  SELECT t.amount, t.description, t.pairId, t.authoritativeForRevenue, c.type as catType
  FROM transactions t
  LEFT JOIN categories c ON t.categoryId = c.id
  WHERE t.restaurantId = ? AND c.type = 'income' AND t.date >= ? AND t.date <= ?
`).all(restId, apr9Start, apr9End);
console.log('Income transactions Apr 9:', apr9IncomeTxns.length);
for (const t of apr9IncomeTxns) console.log(JSON.stringify(t));

const apr9ExpTxns = db.prepare(`
  SELECT t.amount, t.description, c.type as catType
  FROM transactions t
  LEFT JOIN categories c ON t.categoryId = c.id
  WHERE t.restaurantId = ? AND c.type = 'expense' AND t.date >= ? AND t.date <= ?
`).all(restId, apr9Start, apr9End);
console.log('Expense transactions Apr 9:', apr9ExpTxns.length);
for (const t of apr9ExpTxns) console.log(JSON.stringify(t));

db.close();

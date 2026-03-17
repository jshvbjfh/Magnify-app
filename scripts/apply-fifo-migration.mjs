// Applies missing FIFO schema changes directly to the SQLite database
// without resetting existing data.
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

const stmts = [
  // 1. fifoEnabled column on users (safe — ignored if already exists via try/catch)
  `ALTER TABLE users ADD COLUMN fifoEnabled INTEGER NOT NULL DEFAULT 0`,

  // 2. InventoryPurchase table
  `CREATE TABLE IF NOT EXISTS inventory_purchases (
    id TEXT NOT NULL PRIMARY KEY,
    userId TEXT NOT NULL,
    ingredientId TEXT NOT NULL,
    supplier TEXT,
    quantityPurchased REAL NOT NULL,
    remainingQuantity REAL NOT NULL,
    unitCost REAL NOT NULL,
    totalCost REAL NOT NULL,
    purchasedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT inventory_purchases_userId_fkey FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT inventory_purchases_ingredientId_fkey FOREIGN KEY (ingredientId) REFERENCES inventory_items(id) ON DELETE CASCADE ON UPDATE CASCADE
  )`,

  // 3. DishSaleIngredient table
  `CREATE TABLE IF NOT EXISTS dish_sale_ingredients (
    id TEXT NOT NULL PRIMARY KEY,
    dishSaleId TEXT NOT NULL,
    ingredientId TEXT NOT NULL,
    quantityUsed REAL NOT NULL,
    actualCost REAL NOT NULL,
    CONSTRAINT dish_sale_ingredients_dishSaleId_fkey FOREIGN KEY (dishSaleId) REFERENCES dish_sales(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT dish_sale_ingredients_ingredientId_fkey FOREIGN KEY (ingredientId) REFERENCES inventory_items(id) ON DELETE CASCADE ON UPDATE CASCADE
  )`,
]

for (const sql of stmts) {
  try {
    await db.$executeRawUnsafe(sql)
    console.log('OK:', sql.slice(0, 60).replace(/\n/g,' '))
  } catch (e) {
    if (e.message?.includes('duplicate column') || e.message?.includes('already exists')) {
      console.log('SKIP (already exists):', sql.slice(0, 60).replace(/\n/g,' '))
    } else {
      console.error('FAILED:', e.message)
    }
  }
}

await db.$disconnect()
console.log('\nDone — FIFO tables applied.')

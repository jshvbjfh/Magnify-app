/**
 * Branch-switching sync test — Magnify waiter app
 *
 * Simulates what the Electron app does when switching branches:
 * 1. Pull sync (all restaurant dishes returned)
 * 2. Switch to another branch and pull again
 * 3. Verify no UNIQUE constraint violation (the bug we fixed)
 *
 * Run: node tests/waiter-branch-switch.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function log(msg)  { console.log(`  ${msg}`) }
function pass(msg) { console.log(`  ✓ ${msg}`) }
function fail(msg) { console.error(`  ✗ FAIL: ${msg}`); process.exitCode = 1 }

// ── Minimal SQLite setup matching the waiter app's schema ──────────────────

function openDb() {
  // Use node:sqlite in-memory database (Node.js 22+)
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE dishes (
      id TEXT PRIMARY KEY,
      name TEXT,
      selling_price REAL,
      category TEXT,
      menu_type TEXT,
      is_active INTEGER DEFAULT 1,
      branch_id TEXT,
      restaurant_id TEXT
    );
  `)
  return db
}

// ── Replicate the OLD (buggy) replaceDishes logic ─────────────────────────

function replaceDishes_OLD(db, dishes) {
  // Bug: deletes only by the first dish's branch_id, leaves other branches' rows
  const branchId = dishes[0]?.branch_id ?? null
  const restaurantId = dishes[0]?.restaurant_id ?? null

  const deleteSql = branchId && restaurantId
    ? 'DELETE FROM dishes WHERE branch_id = ? AND restaurant_id = ?'
    : 'DELETE FROM dishes'
  const deleteParams = branchId && restaurantId ? [branchId, restaurantId] : []

  db.exec('BEGIN')
  try {
    db.prepare(deleteSql).run(...deleteParams)
    const ins = db.prepare('INSERT INTO dishes (id, name, selling_price, category, menu_type, is_active, branch_id, restaurant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const d of dishes) {
      ins.run(d.id, d.name, d.selling_price, d.category, d.menu_type, d.is_active ? 1 : 0, d.branch_id, d.restaurant_id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ── Replicate the NEW (fixed) replaceDishes logic ─────────────────────────

function replaceDishes_NEW(db, dishes, scope = {}) {
  // Fix: always delete by restaurant_id so the full set can be re-inserted safely
  const restaurantId = scope.restaurantId ?? dishes[0]?.restaurant_id ?? null
  const branchId = scope.branchId ?? null  // null for dishes (restaurant-wide)

  let deleteSql, deleteParams
  if (branchId && restaurantId) {
    deleteSql = 'DELETE FROM dishes WHERE branch_id = ? AND restaurant_id = ?'
    deleteParams = [branchId, restaurantId]
  } else if (restaurantId) {
    deleteSql = 'DELETE FROM dishes WHERE restaurant_id = ?'
    deleteParams = [restaurantId]
  } else {
    deleteSql = 'DELETE FROM dishes'
    deleteParams = []
  }

  db.exec('BEGIN')
  try {
    db.prepare(deleteSql).run(...deleteParams)
    const ins = db.prepare('INSERT INTO dishes (id, name, selling_price, category, menu_type, is_active, branch_id, restaurant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const d of dishes) {
      ins.run(d.id, d.name, d.selling_price, d.category, d.menu_type, d.is_active ? 1 : 0, d.branch_id, d.restaurant_id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ── Test data — simulates pull API returning ALL restaurant dishes ──────────

const RESTAURANT_ID = 'rest-001'

function makeAllDishes() {
  const branches = ['br-bar', 'br-grll', 'br-pizza', 'br-burger', 'br-spirits']
  return [
    { id: 'dish-01', name: 'Chocolate Milkshake', selling_price: 1800, category: 'Drinks', menu_type: 'drink', is_active: 1, branch_id: 'br-bar', restaurant_id: RESTAURANT_ID },
    { id: 'dish-02', name: 'Heineken Beer',       selling_price: 2500, category: 'Drinks', menu_type: 'drink', is_active: 1, branch_id: 'br-bar', restaurant_id: RESTAURANT_ID },
    { id: 'dish-03', name: 'Mojito',              selling_price: 2500, category: 'Drinks', menu_type: 'drink', is_active: 1, branch_id: 'br-bar', restaurant_id: RESTAURANT_ID },
    { id: 'dish-04', name: 'BBQ Beef Ribs',       selling_price: 6500, category: 'Grills', menu_type: 'food',  is_active: 1, branch_id: 'br-grll', restaurant_id: RESTAURANT_ID },
    { id: 'dish-05', name: 'T-Bone Steak',        selling_price: 9500, category: 'Grills', menu_type: 'food',  is_active: 1, branch_id: 'br-grll', restaurant_id: RESTAURANT_ID },
    { id: 'dish-06', name: 'Margherita Pizza',    selling_price: 4500, category: 'Pizza',  menu_type: 'food',  is_active: 1, branch_id: 'br-pizza', restaurant_id: RESTAURANT_ID },
    { id: 'dish-07', name: 'Pepperoni Pizza',     selling_price: 3200, category: 'Pizza',  menu_type: 'food',  is_active: 1, branch_id: 'br-pizza', restaurant_id: RESTAURANT_ID },
    { id: 'dish-08', name: 'Classic Beef Burger', selling_price: 3800, category: 'Burgers',menu_type: 'food',  is_active: 1, branch_id: 'br-burger', restaurant_id: RESTAURANT_ID },
    { id: 'dish-09', name: 'Cheese Burger',       selling_price: 3500, category: 'Burgers',menu_type: 'food',  is_active: 1, branch_id: 'br-burger', restaurant_id: RESTAURANT_ID },
    { id: 'dish-10', name: "Jack Daniel's",       selling_price: 4000, category: 'Spirits',menu_type: 'drink', is_active: 1, branch_id: 'br-spirits', restaurant_id: RESTAURANT_ID },
  ]
}

// ── Run tests ──────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🧪  Branch-switching UNIQUE constraint test\n')

  // ─── Test 1: Old (buggy) code ────────────────────────────────────────────
  log('Test 1 — OLD logic (should fail with UNIQUE constraint error)...')
  const db1 = openDb()
  const allDishes = makeAllDishes()

  // Simulate: first pull on BAR branch (but API returns ALL dishes)
  try {
    replaceDishes_OLD(db1, allDishes)
    const count1 = db1.prepare('SELECT COUNT(*) AS n FROM dishes').get()['n']
    log(`  After first pull: ${count1} dishes in SQLite`)
  } catch (e) {
    fail(`Unexpected error on first pull (old code): ${e.message}`)
  }

  // Simulate: switch to GRILL branch → another pull → SAME set of all dishes
  let oldCodeFailed = false
  try {
    replaceDishes_OLD(db1, allDishes)
    fail('Old code did NOT throw on second pull — expected UNIQUE error')
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      pass(`Old code throws "UNIQUE constraint" as expected: ${e.message}`)
      oldCodeFailed = true
    } else {
      fail(`Old code threw unexpected error: ${e.message}`)
    }
  }

  // ─── Test 2: New (fixed) code ────────────────────────────────────────────
  log('\nTest 2 — NEW logic (should succeed without errors)...')
  const db2 = openDb()
  const dishReplaceScope = { restaurantId: RESTAURANT_ID } // restaurant-wide, no branchId

  // First pull on BAR branch
  try {
    replaceDishes_NEW(db2, allDishes, dishReplaceScope)
    const count1 = db2.prepare('SELECT COUNT(*) AS n FROM dishes').get()['n']
    pass(`First pull: ${count1} dishes stored correctly`)
  } catch (e) {
    fail(`Error on first pull (new code): ${e.message}`)
  }

  // Switch to GRILL branch → second pull (same dish set)
  try {
    replaceDishes_NEW(db2, allDishes, dishReplaceScope)
    const count2 = db2.prepare('SELECT COUNT(*) AS n FROM dishes').get()['n']
    pass(`Branch switch + second pull: ${count2} dishes — no UNIQUE error`)
  } catch (e) {
    fail(`Error on branch switch pull (new code): ${e.message}`)
  }

  // Switch through all other branches
  const branches = ['br-pizza', 'br-burger', 'br-spirits', 'br-bar', 'br-grll']
  for (const br of branches) {
    try {
      replaceDishes_NEW(db2, allDishes, dishReplaceScope)
      pass(`Switched to ${br}: no error`)
    } catch (e) {
      fail(`Error switching to ${br}: ${e.message}`)
    }
  }

  // Verify final count is correct (all 10 dishes, no duplicates)
  const finalCount = db2.prepare('SELECT COUNT(*) AS n FROM dishes').get()['n']
  if (finalCount === allDishes.length) {
    pass(`Final dish count: ${finalCount} ✓ (no duplicates)`)
  } else {
    fail(`Final dish count: ${finalCount} — expected ${allDishes.length}`)
  }

  // ─── Test 3: API login + pull works end-to-end ──────────────────────────
  log('\nTest 3 — API login + pull sync (live server)...')
  try {
    const loginResp = await fetch('https://magnify-app-tau.vercel.app/api/mobile/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'higherfive@gmail.com', password: 'hello@123' }),
    })
    const loginData = await loginResp.json()
    if (!loginData.token) throw new Error('No token in login response')
    pass(`Login OK — branchId: ${loginData.user.branchId}`)

    const pullResp = await fetch('https://magnify-app-tau.vercel.app/api/mobile/pull', {
      headers: { Authorization: `Bearer ${loginData.token}` },
    })
    const pullData = await pullResp.json()
    if (!Array.isArray(pullData.dishes)) throw new Error('dishes not an array in pull response')
    pass(`Pull OK — ${pullData.dishes.length} dishes, ${pullData.tables?.length ?? 0} tables, restaurant: ${pullData.restaurant?.name}`)

    // Simulate replacing dishes twice (second time = branch switch)
    const db3 = openDb()
    const scope = { restaurantId: pullData.restaurant?.id }
    replaceDishes_NEW(db3, pullData.dishes, scope)
    replaceDishes_NEW(db3, pullData.dishes, scope)  // branch switch simulation
    const finalN = db3.prepare('SELECT COUNT(*) AS n FROM dishes').get()['n']
    pass(`Live data branch switch: ${finalN} dishes — no UNIQUE error`)
  } catch (e) {
    fail(`API test error: ${e.message}`)
  }

  const ok = process.exitCode !== 1
  console.log(ok ? '\n✅  All tests passed\n' : '\n❌  Some tests FAILED\n')
}

main().catch(err => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})

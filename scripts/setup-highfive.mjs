/**
 * High 5ive bar and grill — full frontend-API setup script.
 * Uses only HTTP calls to the running Next.js server (port 3001),
 * exactly as a real user would through the Magnify web UI.
 *
 * Run: node scripts/setup-highfive.mjs
 */

const BASE  = 'http://localhost:3001'
const EMAIL = 'highfive@magnify.test'
const PASS  = 'hello@123'
const NAME  = 'High 5ive'

const log  = m => console.log(`  ${m}`)
const ok   = m => console.log(`  ✓ ${m}`)
const fail = m => { console.error(`  ✗ ${m}`); process.exit(1) }

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

let jar = {}

function cookieStr() {
  return Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ')
}

function absorbCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? []
  raw.forEach(c => {
    const part = c.split(';')[0]
    const eq   = part.indexOf('=')
    if (eq > 0) jar[part.slice(0, eq)] = part.slice(eq + 1)
  })
}

async function GET(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookieStr() } })
  absorbCookies(res)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) fail(`GET ${path} → ${res.status}: ${JSON.stringify(body).slice(0,200)}`)
  return body
}

async function POST(path, data, { expectStatus = 200 } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieStr() },
    body: JSON.stringify(data),
  })
  absorbCookies(res)
  const body = await res.json().catch(() => ({}))
  if (res.status !== expectStatus && !res.ok) {
    fail(`POST ${path} → ${res.status}: ${JSON.stringify(body).slice(0,300)}`)
  }
  return body
}

async function PATCH(path, data) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookieStr() },
    body: JSON.stringify(data),
  })
  absorbCookies(res)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) fail(`PATCH ${path} → ${res.status}: ${JSON.stringify(body).slice(0,200)}`)
  return body
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function signup() {
  const res = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, email: EMAIL, password: PASS, trackingMode: 'dish_tracking' }),
  })
  absorbCookies(res)
  const body = await res.json().catch(() => ({}))
  if (res.status === 409) { log('Account already exists — skipping signup'); return }
  if (!res.ok) fail(`Signup failed: ${JSON.stringify(body)}`)
  ok(`Signed up: ${EMAIL}`)
}

async function login() {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  absorbCookies(csrfRes)
  const { csrfToken } = await csrfRes.json()

  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieStr() },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASS, json: 'true' }).toString(),
    redirect: 'manual',
  })
  absorbCookies(res)

  const sess = await fetch(`${BASE}/api/auth/session`, { headers: { Cookie: cookieStr() } }).then(r => r.json())
  if (!sess?.user?.id) fail(`Login failed. Session: ${JSON.stringify(sess)}`)
  ok(`Logged in as ${sess.user.email} (restaurantId: ${sess.user.restaurantId})`)
  return sess
}

// ─── Switch active department ─────────────────────────────────────────────────

async function switchDept(branchId) {
  const res = await PATCH('/api/restaurant/branches', { branchId })
  // The response sets magnify_active_branch cookie automatically (absorbCookies handles it)
  return res
}

// ─── Main setup ───────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔥  Setting up High 5ive bar and grill\n')

  // 1. Signup
  await signup()

  // 2. Login
  await login()

  // 3. Enable dish tracking (may already be set from signup, but make sure)
  await PATCH('/api/user/profile', { trackingMode: 'dish_tracking' })
  ok('Dish tracking enabled')

  // 4. Enable FIFO
  await POST('/api/restaurant/setup', { fifoEnabled: true })
  ok('FIFO inventory enabled')

  // 5. Create 5 departments (branches in the DB)
  console.log('\n  Creating departments...')
  const deptDefs = [
    { name: 'Pizza Station',     code: 'PIZ', isMain: true  },
    { name: 'Burger Station',    code: 'BRG', isMain: false },
    { name: 'Grill & BBQ',       code: 'GRL', isMain: false },
    { name: 'Bar & Drinks',      code: 'BAR', isMain: false },
    { name: 'Spirits & Shots',   code: 'SPR', isMain: false },
  ]

  const { branches: existingBranches } = await GET('/api/restaurant/branches')
  const existingNames = new Set((existingBranches ?? []).map(b => b.name))

  const deptIds = {}
  for (const d of deptDefs) {
    const existing = (existingBranches ?? []).find(b => b.name === d.name)
    if (existing) {
      deptIds[d.name] = existing.id
      log(`Dept already exists: ${d.name}`)
      continue
    }
    const res = await POST('/api/restaurant/branches', { name: d.name, code: d.code, isMain: d.isMain }, { expectStatus: 201 })
    const id = res?.branch?.id ?? res?.id
    if (!id) fail(`No branch id returned for ${d.name}: ${JSON.stringify(res).slice(0,200)}`)
    deptIds[d.name] = id
    ok(`Created department: ${d.name}`)
  }

  // ─── Dept 1: Pizza Station ──────────────────────────────────────────────────
  console.log('\n  ── Pizza Station ──────────────────────────────────')
  await switchDept(deptIds['Pizza Station'])

  // Buy ingredients in 3 batches (different costs per batch)
  const pizzaIngredients = {}

  for (const [name, unit, batches] of [
    ['Flour',           'kg', [[5, 800], [3, 820], [4, 780]]],
    ['Mozzarella',      'kg', [[2, 3500],[1.5, 3600],[2, 3400]]],
    ['Tomato Sauce',    'L',  [[3, 2500], [2, 2600], [2, 2400]]],
    ['Pepperoni',       'kg', [[1, 8000], [1, 8200], [0.5, 7800]]],
  ]) {
    let ingredientId = null
    for (const [qty, cost] of batches) {
      const res = await POST('/api/restaurant/inventory-purchases', {
        itemName: ingredientId ? undefined : name,
        ingredientId,
        unit,
        purchaseQuantity: qty,
        purchaseUnitCost: cost,
        supplier: "High 5ive Suppliers",
        paymentMethod: 'Cash',
      })
      const id = res?.purchase?.ingredientId ?? res?.ingredientId
      if (!ingredientId && id) {
        ingredientId = id
        pizzaIngredients[name] = id
        ok(`Bought ${name}: batch 1 — ${qty}${unit} @ ${cost}`)
      } else {
        ok(`Bought ${name}: next batch — ${qty}${unit} @ ${cost}`)
      }
    }
  }

  // Create pizza dishes and link ingredients
  const pizzaDishes = [
    { name: 'Margherita Pizza (Family)',  sellingPrice: 4500, category: 'Pizza', menuType: 'food',
      ingredients: [['Flour',0.5],['Mozzarella',0.3],['Tomato Sauce',0.2]] },
    { name: 'Margherita Pizza (Regular)', sellingPrice: 2800, category: 'Pizza', menuType: 'food',
      ingredients: [['Flour',0.3],['Mozzarella',0.2],['Tomato Sauce',0.15]] },
    { name: 'Margherita Pizza (Small)',   sellingPrice: 1800, category: 'Pizza', menuType: 'food',
      ingredients: [['Flour',0.2],['Mozzarella',0.1],['Tomato Sauce',0.1]] },
    { name: 'BBQ Chicken Pizza (Family)', sellingPrice: 5200, category: 'Pizza', menuType: 'food',
      ingredients: [['Flour',0.5],['Mozzarella',0.3],['Tomato Sauce',0.2]] },
    { name: 'Pepperoni Pizza (Regular)',  sellingPrice: 3200, category: 'Pizza', menuType: 'food',
      ingredients: [['Flour',0.3],['Mozzarella',0.2],['Tomato Sauce',0.15],['Pepperoni',0.1]] },
  ]

  for (const dish of pizzaDishes) {
    const created = await POST('/api/restaurant/dishes', {
      name: dish.name, sellingPrice: dish.sellingPrice,
      category: dish.category, menuType: dish.menuType,
    }, { expectStatus: 201 })
    const dishId = created?.id
    if (!dishId) fail(`No dish id for ${dish.name}`)

    for (const [ing, qty] of dish.ingredients) {
      if (!pizzaIngredients[ing]) { log(`WARN: ingredient ${ing} not found, skipping`); continue }
      await POST(`/api/restaurant/dishes/${dishId}/ingredients`,
        { inventoryItemId: pizzaIngredients[ing], quantityRequired: qty }, { expectStatus: 201 })
    }
    ok(`Dish: ${dish.name}`)
  }

  // ─── Dept 2: Burger Station ─────────────────────────────────────────────────
  console.log('\n  ── Burger Station ─────────────────────────────────')
  await switchDept(deptIds['Burger Station'])

  const burgerIngredients = {}
  for (const [name, unit, batches] of [
    ['Beef Patties',  'kg',  [[3, 6000],[2, 6200],[2, 5800]]],
    ['Burger Buns',   'pcs', [[20, 200],[15, 220],[20, 190]]],
    ['Cheddar Cheese','kg',  [[1, 4000],[0.5, 4200],[1, 3800]]],
    ['Lettuce',       'kg',  [[2, 1000],[1, 1100],[1.5, 950]]],
  ]) {
    let ingredientId = null
    for (const [qty, cost] of batches) {
      const res = await POST('/api/restaurant/inventory-purchases', {
        itemName: ingredientId ? undefined : name,
        ingredientId,
        unit,
        purchaseQuantity: qty,
        purchaseUnitCost: cost,
        supplier: 'High 5ive Suppliers',
        paymentMethod: 'Cash',
      })
      const id = res?.purchase?.ingredientId ?? res?.ingredientId
      if (!ingredientId && id) {
        ingredientId = id
        burgerIngredients[name] = id
        ok(`Bought ${name}: batch 1 — ${qty}${unit} @ ${cost}`)
      } else {
        ok(`Bought ${name}: next batch — ${qty}${unit} @ ${cost}`)
      }
    }
  }

  const burgerDishes = [
    { name: 'Classic Beef Burger (Big)',     sellingPrice: 3800, category: 'Burgers', menuType: 'food',
      ingredients: [['Beef Patties',0.2],['Burger Buns',1],['Cheddar Cheese',0.05],['Lettuce',0.05]] },
    { name: 'Classic Beef Burger (Regular)', sellingPrice: 3000, category: 'Burgers', menuType: 'food',
      ingredients: [['Beef Patties',0.15],['Burger Buns',1],['Lettuce',0.04]] },
    { name: 'Classic Beef Burger (Small)',   sellingPrice: 2000, category: 'Burgers', menuType: 'food',
      ingredients: [['Beef Patties',0.1],['Burger Buns',1]] },
    { name: 'Chicken Burger (Regular)',      sellingPrice: 2800, category: 'Burgers', menuType: 'food',
      ingredients: [['Burger Buns',1],['Lettuce',0.04]] },
    { name: 'Cheese Burger (Big)',           sellingPrice: 3500, category: 'Burgers', menuType: 'food',
      ingredients: [['Beef Patties',0.2],['Burger Buns',1],['Cheddar Cheese',0.08]] },
    { name: 'Double Smash Burger',           sellingPrice: 4500, category: 'Burgers', menuType: 'food',
      ingredients: [['Beef Patties',0.3],['Burger Buns',1],['Cheddar Cheese',0.1],['Lettuce',0.03]] },
  ]

  for (const dish of burgerDishes) {
    const created = await POST('/api/restaurant/dishes', {
      name: dish.name, sellingPrice: dish.sellingPrice,
      category: dish.category, menuType: dish.menuType,
    }, { expectStatus: 201 })
    const dishId = created?.id
    if (!dishId) fail(`No dish id for ${dish.name}`)
    for (const [ing, qty] of dish.ingredients) {
      if (!burgerIngredients[ing]) { log(`WARN: ingredient ${ing} not found, skipping`); continue }
      await POST(`/api/restaurant/dishes/${dishId}/ingredients`,
        { inventoryItemId: burgerIngredients[ing], quantityRequired: qty }, { expectStatus: 201 })
    }
    ok(`Dish: ${dish.name}`)
  }

  // ─── Dept 3: Grill & BBQ ────────────────────────────────────────────────────
  console.log('\n  ── Grill & BBQ ────────────────────────────────────')
  await switchDept(deptIds['Grill & BBQ'])

  const grillIngredients = {}
  for (const [name, unit, batches] of [
    ['Beef Ribs',     'kg', [[5, 8000],[3, 8500],[4, 7800]]],
    ['T-Bone Steak',  'kg', [[3, 12000],[2, 12500],[2, 11500]]],
    ['Chicken Wings', 'kg', [[5, 4000],[3, 4200],[4, 3800]]],
    ['BBQ Sauce',     'L',  [[2, 3000],[1, 3200],[2, 2800]]],
  ]) {
    let ingredientId = null
    for (const [qty, cost] of batches) {
      const res = await POST('/api/restaurant/inventory-purchases', {
        itemName: ingredientId ? undefined : name,
        ingredientId,
        unit,
        purchaseQuantity: qty,
        purchaseUnitCost: cost,
        supplier: 'Fresh Farm Supplies',
        paymentMethod: 'Bank',
      })
      const id = res?.purchase?.ingredientId ?? res?.ingredientId
      if (!ingredientId && id) {
        ingredientId = id
        grillIngredients[name] = id
        ok(`Bought ${name}: batch 1 — ${qty}${unit} @ ${cost}`)
      } else {
        ok(`Bought ${name}: next batch — ${qty}${unit} @ ${cost}`)
      }
    }
  }

  const grillDishes = [
    { name: 'BBQ Beef Ribs',        sellingPrice: 6500, category: 'Grills', menuType: 'food',
      ingredients: [['Beef Ribs',0.5],['BBQ Sauce',0.1]] },
    { name: 'Grilled T-Bone Steak', sellingPrice: 9500, category: 'Grills', menuType: 'food',
      ingredients: [['T-Bone Steak',0.4],['BBQ Sauce',0.05]] },
    { name: 'BBQ Chicken Wings',    sellingPrice: 4500, category: 'Grills', menuType: 'food',
      ingredients: [['Chicken Wings',0.4],['BBQ Sauce',0.1]] },
    { name: 'Mixed Grill Platter',  sellingPrice: 8000, category: 'Grills', menuType: 'food',
      ingredients: [['Beef Ribs',0.3],['T-Bone Steak',0.2],['Chicken Wings',0.2],['BBQ Sauce',0.15]] },
    { name: 'BBQ Beef Ribs (Full Rack)', sellingPrice: 9000, category: 'Grills', menuType: 'food',
      ingredients: [['Beef Ribs',0.9],['BBQ Sauce',0.2]] },
  ]

  for (const dish of grillDishes) {
    const created = await POST('/api/restaurant/dishes', {
      name: dish.name, sellingPrice: dish.sellingPrice,
      category: dish.category, menuType: dish.menuType,
    }, { expectStatus: 201 })
    const dishId = created?.id
    if (!dishId) fail(`No dish id for ${dish.name}`)
    for (const [ing, qty] of dish.ingredients) {
      if (!grillIngredients[ing]) { log(`WARN: ingredient ${ing} not found, skipping`); continue }
      await POST(`/api/restaurant/dishes/${dishId}/ingredients`,
        { inventoryItemId: grillIngredients[ing], quantityRequired: qty }, { expectStatus: 201 })
    }
    ok(`Dish: ${dish.name}`)
  }

  // ─── Dept 4: Bar & Drinks ───────────────────────────────────────────────────
  console.log('\n  ── Bar & Drinks ───────────────────────────────────')
  await switchDept(deptIds['Bar & Drinks'])

  const barIngredients = {}
  for (const [name, unit, batches] of [
    ['Full Cream Milk', 'L',      [[10, 800],[8, 850],[10, 780]]],
    ['Lime',           'kg',      [[2, 1500],[1, 1600],[2, 1400]]],
    ['White Rum',      'L',       [[2, 12000],[1, 12500],[1, 11500]]],
    ['Heineken Beer',  'bottle',  [[24, 1500],[24, 1600],[12, 1450]]],
  ]) {
    let ingredientId = null
    for (const [qty, cost] of batches) {
      const res = await POST('/api/restaurant/inventory-purchases', {
        itemName: ingredientId ? undefined : name,
        ingredientId,
        unit,
        purchaseQuantity: qty,
        purchaseUnitCost: cost,
        supplier: 'Beverages World',
        paymentMethod: 'Cash',
      })
      const id = res?.purchase?.ingredientId ?? res?.ingredientId
      if (!ingredientId && id) {
        ingredientId = id
        barIngredients[name] = id
        ok(`Bought ${name}: batch 1 — ${qty}${unit} @ ${cost}`)
      } else {
        ok(`Bought ${name}: next batch — ${qty}${unit} @ ${cost}`)
      }
    }
  }

  const barDishes = [
    { name: 'Chocolate Milkshake',  sellingPrice: 1800, category: 'Drinks', menuType: 'drink',
      ingredients: [['Full Cream Milk',0.3]] },
    { name: 'Strawberry Milkshake', sellingPrice: 1800, category: 'Drinks', menuType: 'drink',
      ingredients: [['Full Cream Milk',0.3]] },
    { name: 'Vanilla Milkshake',    sellingPrice: 1800, category: 'Drinks', menuType: 'drink',
      ingredients: [['Full Cream Milk',0.3]] },
    { name: 'Mojito',               sellingPrice: 2500, category: 'Drinks', menuType: 'drink',
      ingredients: [['White Rum',0.05],['Lime',0.05]] },
    { name: 'Virgin Mojito',        sellingPrice: 1800, category: 'Drinks', menuType: 'drink',
      ingredients: [['Lime',0.05]] },
    { name: 'Heineken Beer',        sellingPrice: 2500, category: 'Drinks', menuType: 'drink',
      ingredients: [['Heineken Beer',1]] },
    { name: 'Fresh Orange Juice',   sellingPrice: 1200, category: 'Drinks', menuType: 'drink',
      ingredients: [] },
  ]

  for (const dish of barDishes) {
    const created = await POST('/api/restaurant/dishes', {
      name: dish.name, sellingPrice: dish.sellingPrice,
      category: dish.category, menuType: dish.menuType,
    }, { expectStatus: 201 })
    const dishId = created?.id
    if (!dishId) fail(`No dish id for ${dish.name}`)
    for (const [ing, qty] of dish.ingredients) {
      if (!barIngredients[ing]) { log(`WARN: ingredient ${ing} not found, skipping`); continue }
      await POST(`/api/restaurant/dishes/${dishId}/ingredients`,
        { inventoryItemId: barIngredients[ing], quantityRequired: qty }, { expectStatus: 201 })
    }
    ok(`Dish: ${dish.name}`)
  }

  // ─── Dept 5: Spirits & Shots ─────────────────────────────────────────────────
  console.log('\n  ── Spirits & Shots ────────────────────────────────')
  await switchDept(deptIds['Spirits & Shots'])

  const spiritIngredients = {}
  for (const [name, unit, batches] of [
    ["Jack Daniel's",      'L',      [[2, 35000],[1, 36000],[1, 34000]]],
    ['Amarula Cream',      'L',      [[2, 28000],[1, 29000],[1, 27000]]],
    ['Corona Beer',        'bottle', [[24, 1800],[24, 1900],[12, 1750]]],
    ['Single Malt Whiskey','L',      [[1, 40000],[0.5, 42000],[1, 38000]]],
  ]) {
    let ingredientId = null
    for (const [qty, cost] of batches) {
      const res = await POST('/api/restaurant/inventory-purchases', {
        itemName: ingredientId ? undefined : name,
        ingredientId,
        unit,
        purchaseQuantity: qty,
        purchaseUnitCost: cost,
        supplier: 'Premium Spirits Ltd',
        paymentMethod: 'Bank',
      })
      const id = res?.purchase?.ingredientId ?? res?.ingredientId
      if (!ingredientId && id) {
        ingredientId = id
        spiritIngredients[name] = id
        ok(`Bought ${name}: batch 1 — ${qty}${unit} @ ${cost}`)
      } else {
        ok(`Bought ${name}: next batch — ${qty}${unit} @ ${cost}`)
      }
    }
  }

  const spiritDishes = [
    { name: "Jack Daniel's Whiskey", sellingPrice: 4000, category: 'Spirits', menuType: 'drink',
      ingredients: [["Jack Daniel's",0.05]] },
    { name: 'Amarula Cream',         sellingPrice: 3500, category: 'Spirits', menuType: 'drink',
      ingredients: [['Amarula Cream',0.05]] },
    { name: 'Corona Beer',           sellingPrice: 2200, category: 'Spirits', menuType: 'drink',
      ingredients: [['Corona Beer',1]] },
    { name: 'Single Malt Whiskey',   sellingPrice: 4500, category: 'Spirits', menuType: 'drink',
      ingredients: [['Single Malt Whiskey',0.05]] },
    { name: 'Passion Fruit Mojito',  sellingPrice: 2500, category: 'Spirits', menuType: 'drink',
      ingredients: [['Amarula Cream',0.03]] },
  ]

  for (const dish of spiritDishes) {
    const created = await POST('/api/restaurant/dishes', {
      name: dish.name, sellingPrice: dish.sellingPrice,
      category: dish.category, menuType: dish.menuType,
    }, { expectStatus: 201 })
    const dishId = created?.id
    if (!dishId) fail(`No dish id for ${dish.name}`)
    for (const [ing, qty] of dish.ingredients) {
      if (!spiritIngredients[ing]) { log(`WARN: ingredient ${ing} not found, skipping`); continue }
      await POST(`/api/restaurant/dishes/${dishId}/ingredients`,
        { inventoryItemId: spiritIngredients[ing], quantityRequired: qty }, { expectStatus: 201 })
    }
    ok(`Dish: ${dish.name}`)
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅  High 5ive bar and grill — setup complete
  Email    : ${EMAIL}
  Password : ${PASS}
  Tracking : Dish tracking + FIFO
  Depts    : Pizza Station · Burger Station · Grill & BBQ · Bar & Drinks · Spirits & Shots
  Batches  : 3 batches per ingredient (different costs)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1) })

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadEnvFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '').trim()
      if (!process.env[key]) process.env[key] = val
    }
  } catch {
    // Ignore missing env files.
  }
}

loadEnvFile(resolve(process.cwd(), '.env.local'))
loadEnvFile(resolve(process.cwd(), '.env'))

const { PrismaClient } = await import('@prisma/client')

const db = new PrismaClient(
  process.env.DATABASE_URL
    ? {
        datasources: {
          db: {
            url: process.env.DATABASE_URL,
          },
        },
      }
    : undefined,
)

function roundQty(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 1000) / 1000
}

function getArg(name) {
  const prefix = `--${name}=`
  const match = process.argv.find((arg) => arg.startsWith(prefix))
  return match ? match.slice(prefix.length).trim() : null
}

function detectProvider() {
  const url = String(process.env.DATABASE_URL || '').trim().toLowerCase()
  if (url.startsWith('postgresql://') || url.startsWith('postgres://')) return 'postgresql'
  return 'sqlite'
}

function getRolloutTokens() {
  return new Set(
    String(process.env.FIFO_PILOT_RESTAURANTS || '')
      .split(/[\r\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  )
}

function isRolloutAllowed(restaurant, rolloutTokens) {
  return [restaurant.id, restaurant.syncRestaurantId].some((value) => typeof value === 'string' && rolloutTokens.has(value))
}

async function getTableNames(provider) {
  if (provider === 'postgresql') {
    const rows = await db.$queryRawUnsafe(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `)
    return new Set(rows.map((row) => row.table_name))
  }

  const rows = await db.$queryRawUnsafe(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name
  `)
  return new Set(rows.map((row) => row.name))
}

async function getColumnNames(provider, tableName) {
  if (provider === 'postgresql') {
    const rows = await db.$queryRawUnsafe(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${tableName}'
      ORDER BY ordinal_position
    `)
    return new Set(rows.map((row) => row.column_name))
  }

  const rows = await db.$queryRawUnsafe(`PRAGMA table_info("${tableName}")`)
  return new Set(rows.map((row) => row.name))
}

async function getSchemaStatus(provider) {
  const tableNames = await getTableNames(provider)
  const restaurantColumns = tableNames.has('restaurants') ? await getColumnNames(provider, 'restaurants') : new Set()

  return {
    provider,
    hasRestaurantsFifoEnabled: restaurantColumns.has('fifoEnabled'),
    hasRestaurantsFifoConfiguredAt: restaurantColumns.has('fifoConfiguredAt'),
    hasRestaurantsFifoCutoverAt: restaurantColumns.has('fifoCutoverAt'),
    hasInventoryAdjustmentLogs: tableNames.has('inventory_adjustment_logs'),
    hasInventoryBatchUsageLedgers: tableNames.has('inventory_batch_usage_ledgers'),
  }
}

function getRestaurantSelect(schema) {
  return {
    id: true,
    name: true,
    ownerId: true,
    syncRestaurantId: true,
    ...(schema.hasRestaurantsFifoEnabled ? { fifoEnabled: true } : {}),
    ...(schema.hasRestaurantsFifoConfiguredAt ? { fifoConfiguredAt: true } : {}),
    ...(schema.hasRestaurantsFifoCutoverAt ? { fifoCutoverAt: true } : {}),
  }
}

async function listRestaurants(schema, rolloutTokens) {
  const restaurants = await db.restaurant.findMany({
    orderBy: [{ createdAt: 'asc' }],
    select: getRestaurantSelect(schema),
  })

  return restaurants.map((restaurant) => ({
    ...restaurant,
    fifoEnabled: schema.hasRestaurantsFifoEnabled ? Boolean(restaurant.fifoEnabled) : false,
    fifoConfiguredAt: schema.hasRestaurantsFifoConfiguredAt ? (restaurant.fifoConfiguredAt ?? null) : null,
    fifoCutoverAt: schema.hasRestaurantsFifoCutoverAt ? (restaurant.fifoCutoverAt ?? null) : null,
    rolloutAllowed: isRolloutAllowed(restaurant, rolloutTokens),
  }))
}

async function resolveRestaurant(schema, token) {
  if (!token) return null
  return db.restaurant.findFirst({
    where: {
      OR: [{ id: token }, { syncRestaurantId: token }],
    },
    select: getRestaurantSelect(schema),
  })
}

async function getIntegritySummary(restaurant) {
  const items = await db.inventoryItem.findMany({
    where: {
      userId: restaurant.ownerId,
      restaurantId: restaurant.id,
      inventoryType: 'ingredient',
    },
    select: {
      id: true,
      name: true,
      unit: true,
      quantity: true,
    },
    orderBy: { name: 'asc' },
  })

  const layerGroups = await db.inventoryPurchase.groupBy({
    by: ['ingredientId'],
    where: {
      userId: restaurant.ownerId,
      restaurantId: restaurant.id,
      remainingQuantity: { gt: 0 },
    },
    _sum: {
      remainingQuantity: true,
    },
  })

  const layerMap = new Map(layerGroups.map((row) => [row.ingredientId, roundQty(row._sum.remainingQuantity || 0)]))
  const mismatches = items
    .map((item) => {
      const layerQuantity = layerMap.get(item.id) ?? 0
      const itemQuantity = roundQty(item.quantity)
      const driftQuantity = roundQty(itemQuantity - layerQuantity)
      return {
        ingredientId: item.id,
        ingredientName: item.name,
        unit: item.unit,
        itemQuantity,
        layerQuantity,
        driftQuantity,
      }
    })
    .filter((row) => Math.abs(row.driftQuantity) > 0.001)

  return {
    totalIngredients: items.length,
    mismatchCount: mismatches.length,
    totalAbsoluteDrift: roundQty(mismatches.reduce((sum, row) => sum + Math.abs(row.driftQuantity), 0)),
    mismatches,
  }
}

async function getPostCutoverUsageSummary(schema, restaurant) {
  if (!schema.hasInventoryBatchUsageLedgers || !schema.hasRestaurantsFifoCutoverAt || !restaurant.fifoCutoverAt) {
    return {
      salesChecked: 0,
      saleIngredientChecks: 0,
      salesMissingUsageCount: 0,
      salesQuantityMismatchCount: 0,
      wasteLogsChecked: 0,
      wasteMissingUsageCount: 0,
      wasteQuantityMismatchCount: 0,
    }
  }

  const [sales, wasteLogs, usageRows] = await Promise.all([
    db.dishSale.findMany({
      where: {
        userId: restaurant.ownerId,
        restaurantId: restaurant.id,
        saleDate: { gte: restaurant.fifoCutoverAt },
      },
      include: {
        dish: {
          include: {
            ingredients: true,
          },
        },
      },
    }),
    db.wasteLog.findMany({
      where: {
        userId: restaurant.ownerId,
        restaurantId: restaurant.id,
        date: { gte: restaurant.fifoCutoverAt },
      },
      select: {
        id: true,
        ingredientId: true,
        quantityWasted: true,
      },
    }),
    db.inventoryBatchUsageLedger.findMany({
      where: {
        userId: restaurant.ownerId,
        restaurantId: restaurant.id,
        consumedAt: { gte: restaurant.fifoCutoverAt },
        sourceType: { in: ['dishSale', 'waste'] },
      },
      select: {
        sourceId: true,
        sourceType: true,
        ingredientId: true,
        quantityConsumed: true,
      },
    }),
  ])

  const saleUsageMap = new Map()
  const wasteUsageMap = new Map()

  for (const row of usageRows) {
    const key = `${row.sourceId}:${row.ingredientId}`
    const target = row.sourceType === 'dishSale' ? saleUsageMap : wasteUsageMap
    target.set(key, roundQty((target.get(key) || 0) + Number(row.quantityConsumed || 0)))
  }

  let saleIngredientChecks = 0
  let salesMissingUsageCount = 0
  let salesQuantityMismatchCount = 0

  for (const sale of sales) {
    for (const ingredient of sale.dish.ingredients) {
      saleIngredientChecks += 1
      const expected = roundQty(Number(ingredient.quantityRequired || 0) * Number(sale.quantitySold || 0))
      const actual = saleUsageMap.get(`${sale.id}:${ingredient.ingredientId}`) || 0

      if (actual <= 0) {
        salesMissingUsageCount += 1
        continue
      }

      if (Math.abs(expected - actual) > 0.001) {
        salesQuantityMismatchCount += 1
      }
    }
  }

  let wasteMissingUsageCount = 0
  let wasteQuantityMismatchCount = 0

  for (const waste of wasteLogs) {
    const actual = wasteUsageMap.get(`${waste.id}:${waste.ingredientId}`) || 0
    if (actual <= 0) {
      wasteMissingUsageCount += 1
      continue
    }

    if (Math.abs(Number(waste.quantityWasted || 0) - actual) > 0.001) {
      wasteQuantityMismatchCount += 1
    }
  }

  return {
    salesChecked: sales.length,
    saleIngredientChecks,
    salesMissingUsageCount,
    salesQuantityMismatchCount,
    wasteLogsChecked: wasteLogs.length,
    wasteMissingUsageCount,
    wasteQuantityMismatchCount,
  }
}

function printSection(title) {
  console.log(`\n${title}`)
}

function printLine(label, value) {
  console.log(`${label}: ${value}`)
}

async function main() {
  const provider = detectProvider()
  const restaurantToken = getArg('restaurant')
  const listOnly = process.argv.includes('--list')
  const outputJson = process.argv.includes('--json')
  const rolloutTokens = getRolloutTokens()
  const schema = await getSchemaStatus(provider)
  const restaurants = await listRestaurants(schema, rolloutTokens)

  if (!restaurantToken || listOnly) {
    const payload = {
      schema,
      restaurants: restaurants.map((restaurant) => ({
        id: restaurant.id,
        name: restaurant.name,
        syncRestaurantId: restaurant.syncRestaurantId,
        rolloutAllowed: restaurant.rolloutAllowed,
        fifoEnabled: restaurant.fifoEnabled,
        fifoConfiguredAt: restaurant.fifoConfiguredAt,
        fifoCutoverAt: restaurant.fifoCutoverAt,
      })),
    }

    if (outputJson) {
      console.log(JSON.stringify(payload, null, 2))
    } else {
      printSection('FIFO Pilot Schema')
      printLine('Provider', schema.provider)
      printLine('restaurants.fifoEnabled', schema.hasRestaurantsFifoEnabled ? 'OK' : 'MISSING')
      printLine('restaurants.fifoConfiguredAt', schema.hasRestaurantsFifoConfiguredAt ? 'OK' : 'MISSING')
      printLine('restaurants.fifoCutoverAt', schema.hasRestaurantsFifoCutoverAt ? 'OK' : 'MISSING')
      printLine('inventory_adjustment_logs', schema.hasInventoryAdjustmentLogs ? 'OK' : 'MISSING')
      printLine('inventory_batch_usage_ledgers', schema.hasInventoryBatchUsageLedgers ? 'OK' : 'MISSING')

      printSection('Restaurants')
      if (restaurants.length === 0) {
        console.log('No restaurants found.')
      } else {
        for (const restaurant of restaurants) {
          console.log([
            `${restaurant.name}`,
            `id=${restaurant.id}`,
            restaurant.syncRestaurantId ? `syncRestaurantId=${restaurant.syncRestaurantId}` : 'syncRestaurantId=missing',
            `rollout=${restaurant.rolloutAllowed ? 'allowed' : 'blocked'}`,
            `fifoEnabled=${restaurant.fifoEnabled ? 'true' : 'false'}`,
            `cutover=${restaurant.fifoCutoverAt ? restaurant.fifoCutoverAt.toISOString() : 'not-set'}`,
          ].join(' | '))
        }
      }

      if (!restaurantToken) {
        console.log('\nUse `npm run fifo:pilot:check -- --restaurant=<syncRestaurantId-or-id>` for a branch-level readiness report.')
      }
    }

    if (!restaurantToken) return
  }

  const restaurant = await resolveRestaurant(schema, restaurantToken)
  if (!restaurant) {
    console.error(`Restaurant ${restaurantToken} was not found.`)
    process.exitCode = 1
    return
  }

  restaurant.fifoEnabled = schema.hasRestaurantsFifoEnabled ? Boolean(restaurant.fifoEnabled) : false
  restaurant.fifoConfiguredAt = schema.hasRestaurantsFifoConfiguredAt ? (restaurant.fifoConfiguredAt ?? null) : null
  restaurant.fifoCutoverAt = schema.hasRestaurantsFifoCutoverAt ? (restaurant.fifoCutoverAt ?? null) : null

  const integrity = await getIntegritySummary(restaurant)
  const usage = await getPostCutoverUsageSummary(schema, restaurant)
  const rolloutAllowed = isRolloutAllowed(restaurant, rolloutTokens)
  const schemaReady = Object.values(schema).every((value) => value === true || typeof value === 'string')
  const hasValidationProblems = integrity.mismatchCount > 0 || usage.salesMissingUsageCount > 0 || usage.salesQuantityMismatchCount > 0 || usage.wasteMissingUsageCount > 0 || usage.wasteQuantityMismatchCount > 0
  const status = !schemaReady
    ? 'schema-missing'
    : !rolloutAllowed
      ? 'blocked-by-rollout'
      : !restaurant.fifoCutoverAt
        ? integrity.mismatchCount > 0 ? 'needs-reconciliation' : 'ready-for-cutover'
        : hasValidationProblems ? 'cutover-needs-attention' : 'live-and-validated'

  const payload = {
    schema,
    restaurant: {
      ...restaurant,
      rolloutAllowed,
      rolloutToken: restaurant.syncRestaurantId || restaurant.id,
    },
    integrity,
    usage,
    status,
  }

  if (outputJson) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    printSection('FIFO Pilot Readiness')
    printLine('Status', status)
    printLine('Restaurant', restaurant.name)
    printLine('Restaurant ID', restaurant.id)
    printLine('Sync Restaurant ID', restaurant.syncRestaurantId || 'missing')
    printLine('Pilot allowlist token', restaurant.syncRestaurantId || restaurant.id)
    printLine('Rollout allowed', rolloutAllowed ? 'yes' : 'no')
    printLine('FIFO configured', restaurant.fifoConfiguredAt ? restaurant.fifoConfiguredAt.toISOString() : 'not-set')
    printLine('FIFO cutover', restaurant.fifoCutoverAt ? restaurant.fifoCutoverAt.toISOString() : 'not-set')

    printSection('Integrity')
    printLine('Mismatch count', integrity.mismatchCount)
    printLine('Total absolute drift', `${integrity.totalAbsoluteDrift} units`)
    if (integrity.mismatches.length > 0) {
      for (const mismatch of integrity.mismatches.slice(0, 5)) {
        console.log(`- ${mismatch.ingredientName}: drift ${mismatch.driftQuantity} ${mismatch.unit} (items=${mismatch.itemQuantity}, layers=${mismatch.layerQuantity})`)
      }
      if (integrity.mismatches.length > 5) {
        console.log(`- ${integrity.mismatches.length - 5} more mismatch rows not shown`)
      }
    }

    printSection('Post-cutover usage')
    printLine('Dish sales checked', usage.salesChecked)
    printLine('Dish ingredient checks', usage.saleIngredientChecks)
    printLine('Sales missing usage rows', usage.salesMissingUsageCount)
    printLine('Sales quantity mismatches', usage.salesQuantityMismatchCount)
    printLine('Waste logs checked', usage.wasteLogsChecked)
    printLine('Waste missing usage rows', usage.wasteMissingUsageCount)
    printLine('Waste quantity mismatches', usage.wasteQuantityMismatchCount)

    printSection('Next action')
    if (!schemaReady) {
      console.log('Apply the checked-in Prisma migration before attempting FIFO pilot cutover.')
    } else if (!rolloutAllowed) {
      console.log(`Add ${restaurant.syncRestaurantId || restaurant.id} to FIFO_PILOT_RESTAURANTS before running cutover apply.`)
    } else if (!restaurant.fifoCutoverAt && integrity.mismatchCount > 0) {
      console.log('Run reconciliation preview/apply for this branch, then re-run this readiness check.')
    } else if (!restaurant.fifoCutoverAt) {
      console.log('The branch is ready for reconciliation apply and pilot FIFO cutover.')
    } else if (hasValidationProblems) {
      console.log('Investigate post-cutover usage ledger gaps before treating this branch as fully validated.')
    } else {
      console.log('This branch is live on FIFO and passed the current read-only validation checks.')
    }
  }

  process.exitCode = status === 'ready-for-cutover' || status === 'live-and-validated' ? 0 : 1
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("Can't reach database server")) {
    console.error('Could not reach the configured DATABASE_URL for FIFO pilot checks.')
    console.error('Run this command on the branch machine, VPN-connected host, or any environment that can reach the pilot database.')
  } else {
    console.error(message)
  }
  process.exitCode = 1
} finally {
  await db.$disconnect()
}
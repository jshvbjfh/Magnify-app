import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { PrismaClient } from '@prisma/client'

function loadEnvFile(filePath) {
	if (!existsSync(filePath)) return

	for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue

		const eqIndex = trimmed.indexOf('=')
		if (eqIndex === -1) continue

		const key = trimmed.slice(0, eqIndex).trim()
		const value = trimmed.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, '')
		if (!process.env[key]) process.env[key] = value
	}
}

loadEnvFile(resolve(process.cwd(), '.env.local'))
loadEnvFile(resolve(process.cwd(), '.env'))

const databaseUrl = String(process.env.DATABASE_URL ?? '').trim()
if (!databaseUrl) {
	console.error('DATABASE_URL is required to run the branch integrity repair.')
	process.exit(1)
}

const prisma = new PrismaClient()

// CTE reused across all statements: restaurants with exactly one active branch.
// Only those are safe to auto-assign — multi-branch restaurants need manual resolution.
const SINGLE_BRANCH_CTE = `
  with single_active_branch as (
    select
      rb."restaurantId" as restaurant_id,
      min(rb.id) as branch_id
    from restaurant_branches rb
    where rb."isActive" = true
    group by rb."restaurantId"
    having count(*) = 1
  )
`

// Returns a WHERE fragment that matches rows with a missing or stale branchId.
// "Missing" = null. "Stale" = points to a branch that doesn't belong to this restaurant.
function orphanWhere(tableAlias, restaurantIdCol = '"restaurantId"') {
	return `
    (
      ${tableAlias}."branchId" is null
      or not exists (
        select 1
        from restaurant_branches rb
        where rb.id = ${tableAlias}."branchId"
          and rb.${restaurantIdCol} = ${tableAlias}.${restaurantIdCol}
      )
    )
  `
}

const statements = [
	// dishes
	`${SINGLE_BRANCH_CTE}
	update dishes d
	set "branchId" = sab.branch_id
	from single_active_branch sab
	where d."restaurantId" = sab.restaurant_id
	  and ${orphanWhere('d')}
	`,

	// restaurant_tables
	`${SINGLE_BRANCH_CTE}
	update restaurant_tables t
	set "branchId" = sab.branch_id
	from single_active_branch sab
	where t."restaurantId" = sab.restaurant_id
	  and ${orphanWhere('t')}
	`,

	// inventory_items — was previously skipping null branchId (bug fixed)
	`${SINGLE_BRANCH_CTE}
	update inventory_items i
	set "branchId" = sab.branch_id
	from single_active_branch sab
	where i."restaurantId" = sab.restaurant_id
	  and ${orphanWhere('i')}
	`,

	// inventory_purchases
	`${SINGLE_BRANCH_CTE}
	update inventory_purchases p
	set "branchId" = sab.branch_id
	from single_active_branch sab
	where p."restaurantId" = sab.restaurant_id
	  and ${orphanWhere('p')}
	`,

	// dish_sales
	`${SINGLE_BRANCH_CTE}
	update dish_sales ds
	set "branchId" = sab.branch_id
	from single_active_branch sab
	where ds."restaurantId" = sab.restaurant_id
	  and ${orphanWhere('ds')}
	`,

	// shifts
	`${SINGLE_BRANCH_CTE}
	update shifts s
	set "branchId" = sab.branch_id
	from single_active_branch sab
	where s."restaurantId" = sab.restaurant_id
	  and ${orphanWhere('s')}
	`,

	// waste_logs
	`${SINGLE_BRANCH_CTE}
	update waste_logs w
	set "branchId" = sab.branch_id
	from single_active_branch sab
	where w."restaurantId" = sab.restaurant_id
	  and ${orphanWhere('w')}
	`,

	// employees
	`${SINGLE_BRANCH_CTE}
	update employees e
	set "branchId" = sab.branch_id
	from single_active_branch sab
	where e."restaurantId" = sab.restaurant_id
	  and ${orphanWhere('e')}
	`,

	// inventory_adjustment_logs
	`${SINGLE_BRANCH_CTE}
	update inventory_adjustment_logs ial
	set "branchId" = sab.branch_id
	from single_active_branch sab
	where ial."restaurantId" = sab.restaurant_id
	  and ${orphanWhere('ial')}
	`,
]

const labels = [
	'dishes',
	'restaurant_tables',
	'inventory_items',
	'inventory_purchases',
	'dish_sales',
	'shifts',
	'waste_logs',
	'employees',
	'inventory_adjustment_logs',
]

try {
	const counts = await prisma.$transaction(
		statements.map((statement) => prisma.$executeRawUnsafe(statement)),
	)

	const result = {}
	for (let i = 0; i < labels.length; i++) {
		result[labels[i]] = Number(counts[i] ?? 0)
	}

	console.log(JSON.stringify(result, null, 2))
	process.exit(0)
} catch (error) {
	console.error(error)
	process.exit(1)
} finally {
	await prisma.$disconnect()
}
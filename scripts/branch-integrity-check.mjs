import { readFileSync, existsSync } from 'node:fs'
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

function getLocalSqliteUrl() {
	return `file:${resolve(process.cwd(), 'prisma', 'dev.db').replace(/\\/g, '/')}`
}

// ── Provider + URL normalisation ─────────────────────────────────────────────
// When the script is invoked with PRISMA_FORCE_PROVIDER=sqlite|postgresql,
// ensure DATABASE_URL matches the intended provider. This is needed because
// .env.local may carry a postgres URL even when running the local sqlite check.
const _forceProvider = String(process.env.PRISMA_FORCE_PROVIDER ?? '').trim().toLowerCase()
const _dbUrl = String(process.env.DATABASE_URL ?? '')

if (_forceProvider === 'sqlite') {
	const localSqliteUrl = getLocalSqliteUrl()
	if (_dbUrl !== localSqliteUrl) {
		process.env.DATABASE_URL = localSqliteUrl
		console.error(`[branch-integrity] DATABASE_URL overridden to ${localSqliteUrl} (PRISMA_FORCE_PROVIDER=sqlite)`)
	}
} else if (_forceProvider === 'postgresql') {
	if (!_dbUrl.startsWith('postgresql://') && !_dbUrl.startsWith('postgres://')) {
		console.error('[branch-integrity] ✗ PRISMA_FORCE_PROVIDER=postgresql but DATABASE_URL is not a postgres URL.')
		console.error('  Set DATABASE_URL=postgresql://... in .env.local and retry:')
		console.error('    npm run branch-integrity:check:cloud')
		process.exit(1)
	}
}

const prisma = new PrismaClient()

const CHECKS = [
	{
		label: 'users',
		fetch: () => prisma.user.findMany({
			where: { branchId: { not: null }, restaurantId: { not: null } },
			select: { id: true, email: true, role: true, restaurantId: true, branchId: true },
		}),
		describe: (row) => ({ id: row.id, email: row.email, role: row.role, branchId: row.branchId }),
	},
	{
		label: 'dishes',
		fetch: () => prisma.dish.findMany({
			where: { restaurantId: { not: null } },
			select: { id: true, name: true, restaurantId: true, branchId: true, isActive: true },
		}),
		describe: (row) => ({ id: row.id, name: row.name, branchId: row.branchId, isActive: row.isActive }),
	},
	{
		label: 'restaurant_tables',
		fetch: () => prisma.restaurantTable.findMany({
			select: { id: true, name: true, restaurantId: true, branchId: true, status: true },
		}),
		describe: (row) => ({ id: row.id, name: row.name, branchId: row.branchId, status: row.status }),
	},
	{
		label: 'inventory_items',
		fetch: () => prisma.inventoryItem.findMany({
			where: { restaurantId: { not: null }, branchId: { not: null } },
			select: { id: true, name: true, restaurantId: true, branchId: true, inventoryType: true },
		}),
		describe: (row) => ({ id: row.id, name: row.name, branchId: row.branchId, inventoryType: row.inventoryType }),
	},
]

function groupRowsByRestaurant(rows, restaurantMeta, formatRow) {
	const grouped = new Map()

	for (const row of rows) {
		if (!grouped.has(row.restaurantId)) grouped.set(row.restaurantId, [])
		grouped.get(row.restaurantId).push(formatRow(row))
	}

	return Array.from(grouped.entries())
		.map(([restaurantId, samples]) => ({
			restaurantId,
			restaurantName: restaurantMeta.get(restaurantId)?.name ?? null,
			syncRestaurantId: restaurantMeta.get(restaurantId)?.syncRestaurantId ?? null,
			count: samples.length,
			samples: samples.slice(0, 5),
		}))
		.sort((left, right) => right.count - left.count || String(left.restaurantName).localeCompare(String(right.restaurantName)))
}

async function main() {
	const dbUrl = String(process.env.DATABASE_URL ?? '(not set)')
	const dbLabel = dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://')
		? `cloud-postgres (${dbUrl.replace(/:[^:@]+@/, ':***@')})`
		: dbUrl.startsWith('file:')
			? `local-sqlite (${dbUrl})`
			: `unknown (${dbUrl.slice(0, 40)})`
	console.error(`[branch-integrity] Checking: ${dbLabel}`)
	console.error(`[branch-integrity] Started at: ${new Date().toISOString()}`)

	const restaurants = await prisma.restaurant.findMany({
		select: {
			id: true,
			name: true,
			syncRestaurantId: true,
			branches: { select: { id: true } },
		},
	})

	const branchIdsByRestaurant = new Map(restaurants.map((restaurant) => [
		restaurant.id,
		new Set(restaurant.branches.map((branch) => branch.id)),
	]))
	const restaurantMeta = new Map(restaurants.map((restaurant) => [
		restaurant.id,
		{ name: restaurant.name, syncRestaurantId: restaurant.syncRestaurantId },
	]))

	const summary = {
		checkedAt: new Date().toISOString(),
		totalOrphanRows: 0,
		checks: [],
	}

	for (const check of CHECKS) {
		const rows = await check.fetch()
		const orphanRows = rows.filter((row) => {
			const validBranchIds = branchIdsByRestaurant.get(row.restaurantId ?? '')
			return Boolean(row.branchId) && !validBranchIds?.has(row.branchId)
		})

		summary.totalOrphanRows += orphanRows.length
		summary.checks.push({
			entity: check.label,
			orphanCount: orphanRows.length,
			restaurants: groupRowsByRestaurant(orphanRows, restaurantMeta, check.describe),
		})
	}

	console.log(JSON.stringify(summary, null, 2))

	if (summary.totalOrphanRows > 0) {
		process.exitCode = 1
	}
}

main().catch(async (error) => {
	const dbUrl = String(process.env.DATABASE_URL ?? '')
	const detectedProvider = dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://')
		? 'postgresql'
		: 'sqlite'

	if (error?.code === 'P2022') {
		console.error('\n[branch-integrity] ✗ A required database column is missing — the local schema is out of date.')
		console.error('  Most likely cause: local dev.db has not had all migrations applied yet.')
		console.error('')
		if (detectedProvider === 'sqlite') {
			console.error('  Fix: apply sqlite migrations, then re-check:')
			console.error('    npm run prisma:sqlite:migrate:deploy')
			console.error('    npm run branch-integrity:check:local')
		} else {
			console.error('  Fix: ensure DATABASE_URL points to a fully-migrated postgres database.')
			console.error('    npm run branch-integrity:check:cloud')
		}
		console.error('\n  Prisma detail:', error.message)
	} else if (
		error?.message?.includes('the URL must start with the protocol') ||
		error?.message?.includes('datasource') ||
		error?.message?.includes('provider mismatch')
	) {
		console.error('\n[branch-integrity] ✗ Prisma provider mismatch — generated schema provider does not match DATABASE_URL.')
		console.error(`  DATABASE_URL implies provider: "${detectedProvider}"`)
		console.error('  Re-run with the matching provider variant:')
		console.error(`    npm run branch-integrity:check:${detectedProvider === 'postgresql' ? 'cloud' : 'local'}`)
		console.error('\n  Prisma detail:', error.message)
	} else {
		console.error('\n[branch-integrity] ✗ Unexpected error:')
		console.error(error)
	}
	process.exitCode = 1
}).finally(async () => {
	await prisma.$disconnect()
})
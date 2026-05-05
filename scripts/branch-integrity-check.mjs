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
	console.error(error)
	process.exitCode = 1
}).finally(async () => {
	await prisma.$disconnect()
})
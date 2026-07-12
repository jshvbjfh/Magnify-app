const { app, BrowserWindow, dialog, ipcMain, shell, screen } = require('electron')
const path = require('path')
const http = require('http')
const fs = require('fs')
const os = require('os')
const net = require('net')
const { createHash, randomBytes } = require('crypto')

// Defer electron-updater import — it calls app.getVersion() at module load time,
// which throws when Electron hasn't initialized yet (dev mode / direct launch).
let autoUpdater = null
function getAutoUpdater() {
  if (!autoUpdater) {
    try { autoUpdater = require('electron-updater').autoUpdater } catch { return null }
  }
  return autoUpdater
}

function getStartupLogPath() {
	return path.join(app.getPath('userData'), 'startup.log')
}

const DESKTOP_UPDATE_INITIAL_DELAY_MS = 5000
const DESKTOP_UPDATE_RETRY_DELAYS_MS = [30000, 120000]
const DESKTOP_UPDATE_POLL_INTERVAL_MS = 10 * 60 * 1000
const DESKTOP_PRISMA_COMMAND_TIMEOUT_MS = 120000
const DESKTOP_LEGACY_BASELINE_MIGRATION = '20260518090155_init'
const DESKTOP_BRANCH_FOUNDATION_MIGRATION = '20260518090155_init'
const DESKTOP_INVENTORY_BRANCH_SCOPED_UNIQUE_MIGRATION = '20260518090155_init'

let desktopUpdateDeferredTimer = null
let desktopUpdatePollInterval = null
let desktopUpdateCheckInFlight = false
let desktopUpdateDownloaded = false
let offlineRetryCallback = null
let isOfflineFallback = false

function appendStartupLog(message) {
	try {
		fs.appendFileSync(getStartupLogPath(), `[${new Date().toISOString()}] ${message}\n`, 'utf8')
	} catch {
		// Best-effort logging only.
	}
}

function getDeviceIdentityPath() {
	return path.join(app.getPath('userData'), 'device.json')
}

function getOrCreateDeviceId() {
	const devicePath = getDeviceIdentityPath()
	try {
		if (fs.existsSync(devicePath)) {
			const existing = JSON.parse(fs.readFileSync(devicePath, 'utf8'))
			if (existing && typeof existing.deviceId === 'string' && existing.deviceId.trim()) {
				return existing.deviceId.trim()
			}
		}
	} catch {
		// Regenerate if the device identity cannot be read.
	}

	const deviceId = `branch-device-${randomBytes(12).toString('hex')}`
	try {
		fs.writeFileSync(devicePath, JSON.stringify({ deviceId }, null, 2), 'utf8')
	} catch {
		// Best-effort persistence only.
	}
	return deviceId
}

function createInternalBootstrapSecret() {
	return randomBytes(24).toString('hex')
}

function runInternalBootstrap(serverPort, secret, deviceId) {
	return new Promise((resolve, reject) => {
		const request = http.request({
			hostname: '127.0.0.1',
			port: serverPort,
			path: '/api/internal/bootstrap',
			method: 'POST',
			headers: {
				'x-bootstrap-secret': secret,
				'x-branch-device-id': deviceId,
				'x-app-version': app.getVersion(),
			},
		}, (response) => {
			let raw = ''
			response.on('data', (chunk) => {
				raw += chunk.toString()
			})
			response.on('end', () => {
				try {
					const parsed = raw ? JSON.parse(raw) : {}
					if (response.statusCode && response.statusCode >= 400) {
						reject(new Error(parsed?.lastError || parsed?.error || `Bootstrap failed with status ${response.statusCode}`))
						return
					}
					resolve(parsed)
				} catch (error) {
					reject(error)
				}
			})
		})

		request.on('error', reject)
		request.write('')
		request.end()
	})
}

function normalizeElectronDataMode(value) {
	return String(value || '').trim().toLowerCase() === 'cloud' ? 'cloud' : 'local-first'
}

function isDesktopAutoUpdateEnabled(value) {
	return /^(1|true|yes)$/i.test(String(value || '').trim())
}

function isRunningUnpackedDesktopBuild() {
	const normalizedExecPath = String(process.execPath || '').replace(/\//g, '\\').toLowerCase()
	const normalizedResourcesPath = String(process.resourcesPath || '').replace(/\//g, '\\').toLowerCase()
	return normalizedExecPath.includes('\\dist\\win-unpacked\\') || normalizedResourcesPath.includes('\\win-unpacked\\resources')
}

function clearDesktopUpdateSchedule() {
	if (desktopUpdateDeferredTimer) {
		clearTimeout(desktopUpdateDeferredTimer)
		desktopUpdateDeferredTimer = null
	}
	if (desktopUpdatePollInterval) {
		clearInterval(desktopUpdatePollInterval)
		desktopUpdatePollInterval = null
	}
}

function scheduleDesktopUpdateCheck(reason, attempt, delayMs) {
	if (desktopUpdateDeferredTimer) {
		clearTimeout(desktopUpdateDeferredTimer)
	}
	appendStartupLog(`Scheduling desktop update check (${reason}, attempt ${attempt}) in ${Math.round(delayMs / 1000)}s`)
	desktopUpdateDeferredTimer = setTimeout(() => {
		desktopUpdateDeferredTimer = null
		void checkForDesktopUpdates(reason, attempt)
	}, delayMs)
}

async function checkForDesktopUpdates(reason, attempt = 1) {
	if (desktopUpdateDownloaded) {
		appendStartupLog(`Skipping desktop update check (${reason}) because an update is already downloaded`)
		return
	}
	if (desktopUpdateCheckInFlight) {
		appendStartupLog(`Skipping desktop update check (${reason}) because another check is already in progress`)
		return
	}

	desktopUpdateCheckInFlight = true
	appendStartupLog(`Checking for desktop updates (${reason}, attempt ${attempt})`)

	try {
		const result = await getAutoUpdater()?.checkForUpdates()
		const latestVersion = result?.updateInfo?.version
		appendStartupLog(`Desktop update check completed (${reason})${latestVersion ? ` latest=${latestVersion}` : ''}`)
	} catch (error) {
		appendStartupLog(`Desktop update check failed (${reason}, attempt ${attempt}): ${error?.message || error}`)
		const retryDelay = DESKTOP_UPDATE_RETRY_DELAYS_MS[attempt - 1]
		if (retryDelay) {
			scheduleDesktopUpdateCheck(reason, attempt + 1, retryDelay)
		}
	} finally {
		desktopUpdateCheckInFlight = false
	}
}

function startDesktopUpdateChecks() {
	if (!app.isPackaged) return

	const autoUpdateFlag = String(process.env.ELECTRON_AUTO_UPDATE || '').trim()
	const autoUpdateEnabled = autoUpdateFlag.length ? isDesktopAutoUpdateEnabled(autoUpdateFlag) : true
	appendStartupLog(`Desktop auto-update env=${autoUpdateFlag || 'unset'} enabled=${autoUpdateEnabled}`)

	if (!autoUpdateEnabled) {
		appendStartupLog('Desktop auto-update disabled for this build')
		return
	}

	if (isRunningUnpackedDesktopBuild()) {
		appendStartupLog('Desktop updater warning: app is running from dist/win-unpacked. Windows auto-update is only supported for the installed NSIS app, so this build is not a reliable updater test target.')
	}

	if (desktopUpdatePollInterval || desktopUpdateDeferredTimer) return

	appendStartupLog(`Desktop updater schedule armed: initial=${DESKTOP_UPDATE_INITIAL_DELAY_MS / 1000}s recurring=${DESKTOP_UPDATE_POLL_INTERVAL_MS / 60000}m`)
	scheduleDesktopUpdateCheck('startup', 1, DESKTOP_UPDATE_INITIAL_DELAY_MS)
	desktopUpdatePollInterval = setInterval(() => {
		if (desktopUpdateDeferredTimer) {
			appendStartupLog('Skipping scheduled desktop update check because a deferred retry is already queued')
			return
		}
		void checkForDesktopUpdates('scheduled', 1)
	}, DESKTOP_UPDATE_POLL_INTERVAL_MS)
}

function getRuntimeAssetCandidates(appDir, ...relativeSegments) {
	const relativePath = path.join(...relativeSegments)
	return [
		path.join(process.resourcesPath || '', 'app.asar.unpacked', relativePath),
		path.join(process.resourcesPath || '', 'app', relativePath),
		path.join(appDir, relativePath),
	]
}

function resolveRuntimeAsset(appDir, ...relativeSegments) {
	for (const candidate of getRuntimeAssetCandidates(appDir, ...relativeSegments)) {
		if (candidate && fs.existsSync(candidate)) return candidate
	}
	return null
}

function getBundledNodePaths(appDir) {
	const candidates = [
		path.join(appDir, 'node_modules'),
		path.join(process.resourcesPath || '', 'app', 'node_modules'),
		path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules'),
	]

	return candidates.filter((candidate, index) => {
		if (!candidate || candidates.indexOf(candidate) !== index) return false
		if (candidate.includes('app.asar')) return true
		return fs.existsSync(candidate)
	})
}

function escapeSqliteLiteral(value) {
	return String(value).replace(/'/g, "''")
}

function escapeSqliteIdentifier(value) {
	return String(value).replace(/"/g, '""')
}

function calculateFileSha256(filePath) {
	return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function listPackagedMigrationNamesThrough(migrationsDir, throughMigrationName) {
	if (!migrationsDir || !fs.existsSync(migrationsDir)) return []

	return fs.readdirSync(migrationsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((migrationName) => migrationName <= throughMigrationName && fs.existsSync(path.join(migrationsDir, migrationName, 'migration.sql')))
		.sort()
}

function copyIfPresent(sourcePath, destinationPath) {
	if (!sourcePath || !destinationPath || !fs.existsSync(sourcePath)) return
	fs.copyFileSync(sourcePath, destinationPath)
}

function createDesktopDatabaseBackup(runtimeDbPath, userDataDir, label) {
	if (!runtimeDbPath) {
		throw new Error('Runtime desktop database path is unavailable for backup')
	}

	const backupDir = path.join(userDataDir, 'migration-backups')
	const stamp = new Date().toISOString().replace(/[.:]/g, '-')
	const backupPath = path.join(backupDir, `dev-${label}-${stamp}.db`)

	fs.mkdirSync(backupDir, { recursive: true })
	fs.copyFileSync(runtimeDbPath, backupPath)
	copyIfPresent(`${runtimeDbPath}-journal`, `${backupPath}-journal`)
	copyIfPresent(`${runtimeDbPath}-wal`, `${backupPath}-wal`)
	copyIfPresent(`${runtimeDbPath}-shm`, `${backupPath}-shm`)

	return backupPath
}

function formatDuplicateGroups(duplicateGroups) {
	return Object.entries(duplicateGroups)
		.map(([tableName, count]) => `${tableName}=${count}`)
		.join(', ')
}

async function withDesktopPrismaClient(work) {
	const { PrismaClient } = require('@prisma/client')
	const prisma = new PrismaClient()

	try {
		return await work(prisma)
	} finally {
		try {
			await prisma.$disconnect()
		} catch {
			// Best-effort disconnect only.
		}
	}
}

async function sqliteTableExists(prisma, tableName) {
	const rows = await prisma.$queryRawUnsafe(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='${escapeSqliteLiteral(tableName)}' LIMIT 1`
	)
	return rows.length > 0
}

async function sqliteTableHasColumn(prisma, tableName, columnName) {
	if (!await sqliteTableExists(prisma, tableName)) return false

	const columns = await prisma.$queryRawUnsafe(`PRAGMA table_info("${escapeSqliteIdentifier(tableName)}")`)
	return columns.some((column) => column.name === columnName)
}

async function getDesktopBranchTableContext(prisma) {
	const tableCandidates = ['branches', 'restaurant_branches']

	for (const tableName of tableCandidates) {
		if (!await sqliteTableExists(prisma, tableName)) continue

		return {
			tableName,
			quotedName: `"${escapeSqliteIdentifier(tableName)}"`,
			hasRestaurantId: await sqliteTableHasColumn(prisma, tableName, 'restaurantId'),
			hasIsMain: await sqliteTableHasColumn(prisma, tableName, 'isMain'),
			hasIsActive: await sqliteTableHasColumn(prisma, tableName, 'isActive'),
			hasSortOrder: await sqliteTableHasColumn(prisma, tableName, 'sortOrder'),
			hasCreatedAt: await sqliteTableHasColumn(prisma, tableName, 'createdAt'),
		}
	}

	return null
}

function buildDesktopSingleRestaurantLookupSql() {
	return `(SELECT CASE WHEN COUNT(*) = 1 THEN MIN("id") END FROM "restaurants")`
}

function buildDesktopRestaurantLookupByUserSql(tableName, userColumnName) {
	const tableRef = `"${escapeSqliteIdentifier(tableName)}"`
	const userColumnRef = `"${escapeSqliteIdentifier(userColumnName)}"`

	return `(SELECT "id"
		FROM "restaurants"
		WHERE "ownerId" = ${tableRef}.${userColumnRef}
		   OR "managerId" = ${tableRef}.${userColumnRef}
		ORDER BY "id" ASC
		LIMIT 1)`
}

function buildDesktopBranchLookupSql(branchContext, restaurantIdExpression, { preferMain = false } = {}) {
	if (!branchContext?.hasRestaurantId) return null

	const filters = [`${branchContext.quotedName}."restaurantId" = ${restaurantIdExpression}`]
	if (preferMain && branchContext.hasIsMain) {
		filters.push(`${branchContext.quotedName}."isMain" = 1`)
	}
	if (branchContext.hasIsActive) {
		filters.push(`${branchContext.quotedName}."isActive" = 1`)
	}

	const orderBy = []
	if (branchContext.hasSortOrder) {
		orderBy.push(`${branchContext.quotedName}."sortOrder" ASC`)
	}
	if (branchContext.hasCreatedAt) {
		orderBy.push(`${branchContext.quotedName}."createdAt" ASC`)
	}
	orderBy.push(`${branchContext.quotedName}."id" ASC`)

	return `(SELECT ${branchContext.quotedName}."id"
		FROM ${branchContext.quotedName}
		WHERE ${filters.join(' AND ')}
		ORDER BY ${orderBy.join(', ')}
		LIMIT 1)`
}

async function querySqliteCount(prisma, sql) {
	const rows = await prisma.$queryRawUnsafe(sql)
	return Number(rows?.[0]?.count ?? 0)
}

function isDesktopSchemaCompatibilityRepairCandidate(details) {
	const message = String(details || '')
	// Prisma's "cannot be executed" phrase appears in multiple message formats:
	//   "These changes cannot be executed"  (older Prisma versions)
	//   "We found changes that cannot be executed"  (Prisma 5.x)
	// Match either format. Table names confirm this is a legacy-upgrade compatibility error,
	// not a schema change we should silently skip.
	if (/cannot be executed/i.test(message)
		&& /(branch_devices|dish_ingredients|dish_sale_ingredients|dish_sales|inventory_items|restaurants)/i.test(message)) {
		return true
	}
	// Tables became restaurant-wide (unique on restaurantId+name). On a DB with
	// same-name tables across branches, db push fails creating the new unique
	// index; the repair dedupes restaurant_tables, then a retry succeeds.
	return /unique/i.test(message) && /restaurant_tables/i.test(message)
}

async function attemptDesktopSchemaCompatibilityRepair({ userDataDir, runtimeDbPath, nodePath, prismaCli, schemaPath, migrationEnv }) {
	if (!runtimeDbPath || !fs.existsSync(runtimeDbPath)) {
		return {
			attempted: false,
			repaired: false,
			reason: 'Runtime desktop database is unavailable for schema compatibility repair',
			backupPath: null,
			actions: [],
			branchTableName: null,
		}
	}

	let backupPath = null
	const actions = []

	try {
		backupPath = createDesktopDatabaseBackup(runtimeDbPath, userDataDir, 'schema-compat')
	} catch (backupErr) {
		return {
			attempted: true,
			repaired: false,
			reason: `Database backup failed before repair: ${backupErr?.message || backupErr}`,
			backupPath: null,
			actions: [],
			branchTableName: null,
		}
	}

	// Run individual SQL statements via the Prisma CLI (prisma db execute --stdin).
	// This avoids any dependency on @prisma/client or the generated .prisma/client/default
	// module, which is NOT present in the packaged build because electron-builder runs a
	// clean production `npm install` without `prisma generate`.
	const { execFileSync: execFileSyncRepair } = require('child_process')

	function dbExecute(sql, benignPatterns) {
		try {
			execFileSyncRepair(nodePath, [prismaCli, 'db', 'execute', '--stdin', '--schema', schemaPath], {
				input: sql,
				env: migrationEnv,
				timeout: 30000,
				stdio: ['pipe', 'pipe', 'pipe'],
			})
			return { ok: true }
		} catch (e) {
			const msg = `${e.message || ''} ${e.stderr?.toString() || ''} ${e.stdout?.toString() || ''}`
			for (const pattern of (benignPatterns || [])) {
				if (msg.toLowerCase().includes(pattern.toLowerCase())) return { ok: true, skipped: pattern }
			}
			return { ok: false, error: msg.slice(0, 500) }
		}
	}

	const SKIP_DUP = ['duplicate column name']
	const SKIP_TABLE = ['duplicate column name', 'no such table']
	const SKIP_SOFT = ['duplicate column name', 'no such table', 'no such column']

	let r

	// users
	r = dbExecute(`ALTER TABLE "users" ADD COLUMN "isActive" INTEGER NOT NULL DEFAULT 1;`, SKIP_DUP)
	if (r.ok && !r.skipped) actions.push('Added users.isActive')
	r = dbExecute(`ALTER TABLE "users" ADD COLUMN "isSuperAdmin" INTEGER NOT NULL DEFAULT 0;`, SKIP_DUP)
	if (r.ok && !r.skipped) actions.push('Added users.isSuperAdmin')
	r = dbExecute(`ALTER TABLE "users" ADD COLUMN "businessType" TEXT;`, SKIP_DUP)
	if (r.ok && !r.skipped) actions.push('Added users.businessType')
	r = dbExecute(`ALTER TABLE "users" ADD COLUMN "logoUrl" TEXT;`, SKIP_DUP)
	if (r.ok && !r.skipped) actions.push('Added users.logoUrl')
	r = dbExecute(`ALTER TABLE "users" ADD COLUMN "trackingMode" TEXT NOT NULL DEFAULT 'simple';`, SKIP_DUP)
	if (r.ok && !r.skipped) actions.push('Added users.trackingMode')
	r = dbExecute(`ALTER TABLE "users" ADD COLUMN "fifoEnabled" INTEGER NOT NULL DEFAULT 0;`, SKIP_DUP)
	if (r.ok && !r.skipped) actions.push('Added users.fifoEnabled')

	// restaurants
	r = dbExecute(`ALTER TABLE "restaurants" ADD COLUMN "managerId" TEXT;`, SKIP_DUP)
	if (r.ok && !r.skipped) actions.push('Added restaurants.managerId')
	r = dbExecute(`ALTER TABLE "restaurants" ADD COLUMN "fifoEnabled" INTEGER NOT NULL DEFAULT 1;`, SKIP_DUP)
	if (r.ok && !r.skipped) actions.push('Added restaurants.fifoEnabled')
	r = dbExecute(`ALTER TABLE "restaurants" ADD COLUMN "fifoConfiguredAt" DATETIME;`, SKIP_DUP)
	if (r.ok && !r.skipped) actions.push('Added restaurants.fifoConfiguredAt')
	r = dbExecute(`ALTER TABLE "restaurants" ADD COLUMN "syncRestaurantId" TEXT;`, SKIP_DUP)
	if (r.ok && !r.skipped) actions.push('Added restaurants.syncRestaurantId')
	r = dbExecute(`ALTER TABLE "restaurants" ADD COLUMN "deletedAt" DATETIME;`, SKIP_DUP)
	if (r.ok && !r.skipped) actions.push('Added restaurants.deletedAt')

	// branches: create the table if this is a pre-branch-era DB (table never existed)
	r = dbExecute(`
		CREATE TABLE IF NOT EXISTS "branches" (
			"id" TEXT NOT NULL PRIMARY KEY,
			"restaurantId" TEXT NOT NULL,
			"name" TEXT NOT NULL DEFAULT 'Main Branch',
			"code" TEXT NOT NULL DEFAULT 'MAIN',
			"isMain" INTEGER NOT NULL DEFAULT 1,
			"isActive" INTEGER NOT NULL DEFAULT 1,
			"address" TEXT,
			"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			"updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			"deletedAt" DATETIME
		);
	`, SKIP_SOFT)
	if (r.ok && !r.skipped) actions.push('Created branches table')
	// Seed one default main branch per restaurant that has no branch yet
	dbExecute(`
		INSERT INTO "branches" ("id", "restaurantId", "name", "code", "isMain", "isActive", "createdAt", "updatedAt")
		SELECT
			'branch-' || r."id",
			r."id",
			'Main Branch',
			'MAIN',
			1,
			1,
			CURRENT_TIMESTAMP,
			CURRENT_TIMESTAMP
		FROM "restaurants" r
		WHERE NOT EXISTS (SELECT 1 FROM "branches" WHERE "restaurantId" = r."id");
	`, SKIP_SOFT)
	r = dbExecute(`ALTER TABLE "branches" ADD COLUMN "deletedAt" DATETIME;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added branches.deletedAt')
	r = dbExecute(`ALTER TABLE "branches" ADD COLUMN "billHeader" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added branches.billHeader')
	r = dbExecute(`ALTER TABLE "branches" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'kitchen';`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added branches.type')

	// dishes
	r = dbExecute(`ALTER TABLE "dishes" ADD COLUMN "description" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added dishes.description')
	r = dbExecute(`ALTER TABLE "dishes" ADD COLUMN "deletedAt" DATETIME;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added dishes.deletedAt')

	// restaurant_tables
	r = dbExecute(`ALTER TABLE "restaurant_tables" ADD COLUMN "deletedAt" DATETIME;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added restaurant_tables.deletedAt')

	// Tables are now restaurant-wide (unique on restaurantId+name, not branchId+name).
	// Collapse any same-name duplicates across branches BEFORE db push tries to create
	// the new unique index — otherwise the index creation fails on duplicate data.
	r = dbExecute(`
		UPDATE "restaurant_orders"
		SET "tableId" = (
			SELECT s."id" FROM "restaurant_tables" s
			JOIN "restaurant_tables" t ON t."id" = "restaurant_orders"."tableId"
			WHERE s."restaurantId" = t."restaurantId" AND s."name" = t."name"
			ORDER BY s."rowid" ASC LIMIT 1
		)
		WHERE "tableId" IS NOT NULL AND "tableId" IN (SELECT "id" FROM "restaurant_tables");
		UPDATE "restaurant_tables" SET "status" = 'occupied'
		WHERE EXISTS (
			SELECT 1 FROM "restaurant_tables" d
			WHERE d."restaurantId" = "restaurant_tables"."restaurantId"
				AND d."name" = "restaurant_tables"."name" AND d."status" = 'occupied'
		);
		DELETE FROM "restaurant_tables"
		WHERE "rowid" NOT IN (
			SELECT MIN("rowid") FROM "restaurant_tables" GROUP BY "restaurantId", "name"
		);
	`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Deduplicated restaurant_tables by restaurantId+name')
	r = dbExecute(`DROP INDEX IF EXISTS "restaurant_tables_branchId_name_key";`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Dropped restaurant_tables branchId unique index')
	r = dbExecute(`CREATE UNIQUE INDEX IF NOT EXISTS "restaurant_tables_restaurantId_name_key" ON "restaurant_tables"("restaurantId", "name");`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Created restaurant_tables restaurantId unique index')

	// restaurant_orders
	r = dbExecute(`ALTER TABLE "restaurant_orders" ADD COLUMN "staffId" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added restaurant_orders.staffId')
	r = dbExecute(`ALTER TABLE "restaurant_orders" ADD COLUMN "notes" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added restaurant_orders.notes')
	r = dbExecute(`ALTER TABLE "restaurant_orders" ADD COLUMN "servedAt" DATETIME;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added restaurant_orders.servedAt')
	r = dbExecute(`ALTER TABLE "restaurant_orders" ADD COLUMN "journalEntryId" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added restaurant_orders.journalEntryId')
	r = dbExecute(`ALTER TABLE "restaurant_orders" ADD COLUMN "deletedAt" DATETIME;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added restaurant_orders.deletedAt')

	// inventory_items (restaurantId + branchId handled below; add remaining nullable cols here)
	r = dbExecute(`ALTER TABLE "inventory_items" ADD COLUMN "description" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added inventory_items.description')
	r = dbExecute(`ALTER TABLE "inventory_items" ADD COLUMN "deletedAt" DATETIME;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added inventory_items.deletedAt')
	r = dbExecute(`ALTER TABLE "inventory_items" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'purchased';`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added inventory_items.type')

	// inventory_purchases
	r = dbExecute(`ALTER TABLE "inventory_purchases" ADD COLUMN "paymentMethod" TEXT NOT NULL DEFAULT 'Cash';`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added inventory_purchases.paymentMethod')
	r = dbExecute(`ALTER TABLE "inventory_purchases" ADD COLUMN "journalEntryId" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added inventory_purchases.journalEntryId')
	r = dbExecute(`ALTER TABLE "inventory_purchases" ADD COLUMN "deletedAt" DATETIME;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added inventory_purchases.deletedAt')
	r = dbExecute(`ALTER TABLE "inventory_purchases" ADD COLUMN "purchaseQuantity" REAL;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added inventory_purchases.purchaseQuantity')
	r = dbExecute(`ALTER TABLE "inventory_purchases" ADD COLUMN "purchaseUnit" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added inventory_purchases.purchaseUnit')
	r = dbExecute(`ALTER TABLE "inventory_purchases" ADD COLUMN "unitsPerPurchaseUnit" REAL;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added inventory_purchases.unitsPerPurchaseUnit')
	r = dbExecute(`ALTER TABLE "inventory_purchases" ADD COLUMN "purchaseUnitCost" REAL;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added inventory_purchases.purchaseUnitCost')

	// dish_ingredients
	r = dbExecute(`ALTER TABLE "dish_ingredients" ADD COLUMN "inventoryItemId" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added dish_ingredients.inventoryItemId')
	dbExecute(
		`UPDATE "dish_ingredients" SET "inventoryItemId" = COALESCE("inventoryItemId", "ingredientId") WHERE ("inventoryItemId" IS NULL OR TRIM("inventoryItemId") = '') AND "ingredientId" IS NOT NULL;`,
		SKIP_SOFT
	)
	r = dbExecute(`ALTER TABLE "dish_ingredients" ADD COLUMN "updatedAt" DATETIME;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added dish_ingredients.updatedAt')
	dbExecute(
		`UPDATE "dish_ingredients" SET "updatedAt" = COALESCE("updatedAt", "createdAt", CURRENT_TIMESTAMP) WHERE "updatedAt" IS NULL;`,
		SKIP_SOFT
	)

	// dish_sale_ingredients
	r = dbExecute(`ALTER TABLE "dish_sale_ingredients" ADD COLUMN "updatedAt" DATETIME;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added dish_sale_ingredients.updatedAt')
	dbExecute(
		`UPDATE "dish_sale_ingredients" SET "updatedAt" = COALESCE("updatedAt", "createdAt", CURRENT_TIMESTAMP) WHERE "updatedAt" IS NULL;`,
		SKIP_SOFT
	)

	// dish_sales
	r = dbExecute(`ALTER TABLE "dish_sales" ADD COLUMN "restaurantId" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added dish_sales.restaurantId')
	r = dbExecute(`ALTER TABLE "dish_sales" ADD COLUMN "branchId" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added dish_sales.branchId')
	r = dbExecute(`ALTER TABLE "dish_sales" ADD COLUMN "dishName" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added dish_sales.dishName')
	r = dbExecute(`ALTER TABLE "dish_sales" ADD COLUMN "updatedAt" DATETIME;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added dish_sales.updatedAt')
	r = dbExecute(`ALTER TABLE "dish_sales" ADD COLUMN "deletedAt" DATETIME;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added dish_sales.deletedAt')
	dbExecute(
		`UPDATE "dish_sales" SET "restaurantId" = COALESCE("restaurantId", (SELECT "restaurantId" FROM "restaurant_orders" WHERE "id" = "dish_sales"."orderId" LIMIT 1), (SELECT "restaurantId" FROM "dishes" WHERE "id" = "dish_sales"."dishId" LIMIT 1), (SELECT "id" FROM "restaurants" LIMIT 1)) WHERE "restaurantId" IS NULL;`,
		SKIP_SOFT
	)
	dbExecute(
		`UPDATE "dish_sales" SET "branchId" = COALESCE("branchId", (SELECT "branchId" FROM "restaurant_orders" WHERE "id" = "dish_sales"."orderId" LIMIT 1), (SELECT "id" FROM "branches" WHERE "restaurantId" = "dish_sales"."restaurantId" AND "isMain" = 1 LIMIT 1), (SELECT "id" FROM "branches" WHERE "restaurantId" = "dish_sales"."restaurantId" LIMIT 1)) WHERE "branchId" IS NULL AND "restaurantId" IS NOT NULL;`,
		SKIP_SOFT
	)
	dbExecute(
		`UPDATE "dish_sales" SET "dishName" = COALESCE("dishName", (SELECT "name" FROM "dishes" WHERE "id" = "dish_sales"."dishId" LIMIT 1), "dishId", 'Dish') WHERE "dishName" IS NULL OR TRIM("dishName") = '';`,
		SKIP_SOFT
	)
	dbExecute(
		`UPDATE "dish_sales" SET "updatedAt" = COALESCE("updatedAt", "saleDate", "createdAt", CURRENT_TIMESTAMP) WHERE "updatedAt" IS NULL;`,
		SKIP_SOFT
	)
	// last-resort fallbacks: only reference stable core columns, cannot fail with "no such column"
	dbExecute(`UPDATE "dish_sales" SET "restaurantId" = (SELECT "id" FROM "restaurants" LIMIT 1) WHERE "restaurantId" IS NULL;`, SKIP_SOFT)
	dbExecute(`UPDATE "dish_sales" SET "branchId" = (SELECT "id" FROM "branches" LIMIT 1) WHERE "branchId" IS NULL;`, SKIP_SOFT)
	dbExecute(`UPDATE "dish_sales" SET "dishName" = 'Dish' WHERE "dishName" IS NULL OR TRIM("dishName") = '';`, SKIP_SOFT)
	dbExecute(`UPDATE "dish_sales" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "updatedAt" IS NULL;`, SKIP_SOFT)

	// inventory_items
	r = dbExecute(`ALTER TABLE "inventory_items" ADD COLUMN "restaurantId" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added inventory_items.restaurantId')
	r = dbExecute(`ALTER TABLE "inventory_items" ADD COLUMN "branchId" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added inventory_items.branchId')
	dbExecute(
		`UPDATE "inventory_items" SET "restaurantId" = COALESCE("restaurantId", (SELECT "id" FROM "restaurants" LIMIT 1)) WHERE "restaurantId" IS NULL;`,
		SKIP_SOFT
	)
	dbExecute(
		`UPDATE "inventory_items" SET "branchId" = COALESCE("branchId", (SELECT "id" FROM "branches" WHERE "restaurantId" = "inventory_items"."restaurantId" AND "isMain" = 1 LIMIT 1), (SELECT "id" FROM "branches" WHERE "restaurantId" = "inventory_items"."restaurantId" LIMIT 1)) WHERE "branchId" IS NULL AND "restaurantId" IS NOT NULL;`,
		SKIP_SOFT
	)
	// last-resort fallbacks
	dbExecute(`UPDATE "inventory_items" SET "restaurantId" = (SELECT "id" FROM "restaurants" LIMIT 1) WHERE "restaurantId" IS NULL;`, SKIP_SOFT)
	dbExecute(`UPDATE "inventory_items" SET "branchId" = (SELECT "id" FROM "branches" LIMIT 1) WHERE "branchId" IS NULL;`, SKIP_SOFT)

	// staff
	r = dbExecute(`ALTER TABLE "staff" ADD COLUMN "hourlyRate" REAL;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added staff.hourlyRate')

	// employee_shifts
	r = dbExecute(`ALTER TABLE "employee_shifts" ADD COLUMN "calculatedWage" REAL;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added employee_shifts.calculatedWage')

	// branch_devices
	r = dbExecute(`ALTER TABLE "branch_devices" ADD COLUMN "restaurantId" TEXT;`, SKIP_TABLE)
	if (r.ok && !r.skipped) actions.push('Added branch_devices.restaurantId')
	dbExecute(
		`UPDATE "branch_devices" SET "restaurantId" = COALESCE("restaurantId", (SELECT "restaurantId" FROM "branches" WHERE "id" = "branch_devices"."branchId" LIMIT 1), (SELECT "id" FROM "restaurants" LIMIT 1)) WHERE "restaurantId" IS NULL;`,
		SKIP_SOFT
	)
	// last-resort fallback
	dbExecute(`UPDATE "branch_devices" SET "restaurantId" = (SELECT "id" FROM "restaurants" LIMIT 1) WHERE "restaurantId" IS NULL;`, SKIP_SOFT)

	return {
		attempted: true,
		repaired: actions.length > 0,
		reason: actions.length > 0
			? `Applied compatibility repair: ${actions.join('; ')}`
			: 'No schema changes needed (all columns already present)',
		backupPath,
		actions,
		branchTableName: null,
	}
}

async function getLegacyDesktopBranchDuplicateGroups(prisma) {
	const duplicateQueries = [
		[
			'daily_summaries',
			`SELECT COUNT(*) AS duplicate_groups
			 FROM (
				SELECT "userId", "restaurantId", ('branch_' || "restaurantId") AS "futureBranchId", "date", COUNT(*) AS c
				FROM "daily_summaries"
				WHERE "restaurantId" IS NOT NULL
				GROUP BY "userId", "restaurantId", "futureBranchId", "date"
				HAVING COUNT(*) > 1
			 )`
		],
		[
			'dishes',
			`SELECT COUNT(*) AS duplicate_groups
			 FROM (
				SELECT "userId", "restaurantId", ('branch_' || "restaurantId") AS "futureBranchId", "name", COUNT(*) AS c
				FROM "dishes"
				WHERE "restaurantId" IS NOT NULL
				GROUP BY "userId", "restaurantId", "futureBranchId", "name"
				HAVING COUNT(*) > 1
			 )`
		],
		[
			'inventory_items',
			`SELECT COUNT(*) AS duplicate_groups
			 FROM (
				SELECT "userId", "restaurantId", ('branch_' || "restaurantId") AS "futureBranchId", "name", COUNT(*) AS c
				FROM "inventory_items"
				WHERE "restaurantId" IS NOT NULL
				GROUP BY "userId", "restaurantId", "futureBranchId", "name"
				HAVING COUNT(*) > 1
			 )`
		],
		[
			'restaurant_actions',
			`SELECT COUNT(*) AS duplicate_groups
			 FROM (
				SELECT "restaurantId", ('branch_' || "restaurantId") AS "futureBranchId", "actionKey", COUNT(*) AS c
				FROM "restaurant_actions"
				GROUP BY "restaurantId", "futureBranchId", "actionKey"
				HAVING COUNT(*) > 1
			 )`
		],
		[
			'restaurant_orders',
			`SELECT COUNT(*) AS duplicate_groups
			 FROM (
				SELECT "restaurantId", ('branch_' || "restaurantId") AS "futureBranchId", "orderNumber", COUNT(*) AS c
				FROM "restaurant_orders"
				GROUP BY "restaurantId", "futureBranchId", "orderNumber"
				HAVING COUNT(*) > 1
			 )`
		],
	]

	const duplicateGroups = {}

	for (const [tableName, sql] of duplicateQueries) {
		const rows = await prisma.$queryRawUnsafe(sql)
		duplicateGroups[tableName] = Number(rows?.[0]?.duplicate_groups || 0)
	}

	return duplicateGroups
}

async function inspectLegacyDesktopBranchRepairState() {
	try {
		return await withDesktopPrismaClient(async (prisma) => {
			const hasMigrationTable = await sqliteTableExists(prisma, '_prisma_migrations')
			if (hasMigrationTable) {
				return {
					canRepair: false,
					reason: 'Prisma migration history already exists',
					duplicateGroups: null,
				}
			}

			const hasAppSchemaState = await sqliteTableExists(prisma, 'app_schema_state')
			const hasBranchDevices = await sqliteTableExists(prisma, 'branch_devices')
			const hasRestaurantBranches = await sqliteTableExists(prisma, 'restaurant_branches')
			const usersHasBranchId = await sqliteTableHasColumn(prisma, 'users', 'branchId')
			const branchDevicesHasBranchId = await sqliteTableHasColumn(prisma, 'branch_devices', 'branchId')
			const inventoryItemsHasPurchaseUnit = await sqliteTableHasColumn(prisma, 'inventory_items', 'purchaseUnit')
			const inventoryPurchasesHasJournalPairId = await sqliteTableHasColumn(prisma, 'inventory_purchases', 'journalPairId')
			const restaurantsHasFifoConfiguredAt = await sqliteTableHasColumn(prisma, 'restaurants', 'fifoConfiguredAt')
			const duplicateGroups = (
				hasAppSchemaState &&
				hasBranchDevices &&
				!hasRestaurantBranches &&
				!usersHasBranchId &&
				!branchDevicesHasBranchId
			)
				? await getLegacyDesktopBranchDuplicateGroups(prisma)
				: null

			if (!hasAppSchemaState || !hasBranchDevices) {
				return {
					canRepair: false,
					reason: 'Legacy desktop baseline markers are missing',
					duplicateGroups,
				}
			}

			if (hasRestaurantBranches || usersHasBranchId || branchDevicesHasBranchId) {
				return {
					canRepair: false,
					reason: 'Branch foundation already appears partially applied',
					duplicateGroups,
				}
			}

			if (!inventoryItemsHasPurchaseUnit || !inventoryPurchasesHasJournalPairId || !restaurantsHasFifoConfiguredAt) {
				return {
					canRepair: false,
					reason: `Database is not at the expected ${DESKTOP_LEGACY_BASELINE_MIGRATION} baseline`,
					duplicateGroups,
				}
			}

			if (duplicateGroups && Object.values(duplicateGroups).some((count) => count > 0)) {
				return {
					canRepair: false,
					reason: `Duplicate rows would block unique indexes (${formatDuplicateGroups(duplicateGroups)})`,
					duplicateGroups,
				}
			}

			return {
				canRepair: true,
				reason: 'Legacy pre-branch desktop database detected',
				duplicateGroups,
			}
		})
	} catch (error) {
		return {
			canRepair: false,
			reason: `Legacy repair inspection failed: ${error?.message || error}`,
			duplicateGroups: null,
		}
	}
}

async function stampAppliedDesktopMigrations(migrationsDir, throughMigrationName) {
	const migrationNames = listPackagedMigrationNamesThrough(migrationsDir, throughMigrationName)
	if (migrationNames.length === 0) {
		throw new Error(`No packaged migrations were found through ${throughMigrationName}`)
	}

	await withDesktopPrismaClient(async (prisma) => {
		await prisma.$executeRawUnsafe(`
			CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
				"id" TEXT PRIMARY KEY NOT NULL,
				"checksum" TEXT NOT NULL,
				"finished_at" DATETIME,
				"migration_name" TEXT NOT NULL,
				"logs" TEXT,
				"rolled_back_at" DATETIME,
				"started_at" DATETIME NOT NULL DEFAULT current_timestamp,
				"applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
			)
		`)

		for (const migrationName of migrationNames) {
			const migrationFilePath = path.join(migrationsDir, migrationName, 'migration.sql')
			const checksum = calculateFileSha256(migrationFilePath)
			const existingRows = await prisma.$queryRawUnsafe(
				`SELECT "id", "finished_at" AS finished_at, "rolled_back_at" AS rolled_back_at
				 FROM "_prisma_migrations"
				 WHERE "migration_name" = '${escapeSqliteLiteral(migrationName)}'
				 ORDER BY "started_at" DESC
				 LIMIT 1`
			)

			if (existingRows.length > 0) {
				const existingRow = existingRows[0]
				if (existingRow.finished_at && !existingRow.rolled_back_at) continue

				await prisma.$executeRawUnsafe(`
					UPDATE "_prisma_migrations"
					SET
						"checksum" = '${escapeSqliteLiteral(checksum)}',
						"finished_at" = CURRENT_TIMESTAMP,
						"logs" = NULL,
						"rolled_back_at" = NULL,
						"applied_steps_count" = 1
					WHERE "id" = '${escapeSqliteLiteral(existingRow.id)}'
				`)
				continue
			}

			const migrationId = `desktop-baseline-${randomBytes(12).toString('hex')}`

			await prisma.$executeRawUnsafe(`
				INSERT INTO "_prisma_migrations" (
					"id",
					"checksum",
					"finished_at",
					"migration_name",
					"logs",
					"rolled_back_at",
					"started_at",
					"applied_steps_count"
				)
				VALUES (
					'${escapeSqliteLiteral(migrationId)}',
					'${escapeSqliteLiteral(checksum)}',
					CURRENT_TIMESTAMP,
					'${escapeSqliteLiteral(migrationName)}',
					NULL,
					NULL,
					CURRENT_TIMESTAMP,
					1
				)
			`)
		}
	})
}

async function attemptInventoryBranchScopedUniqueRepair({ migrationsDir, userDataDir, runtimeDbPath }) {
	if (!runtimeDbPath) {
		return {
			attempted: true,
			repaired: false,
			reason: 'Runtime desktop database path is unavailable for inventory branch unique repair',
			backupPath: null,
			stampWarning: null,
			migrationOutput: '',
		}
	}

	if (!migrationsDir || !fs.existsSync(migrationsDir)) {
		return {
			attempted: true,
			repaired: false,
			reason: 'Packaged migration directory is unavailable for inventory branch unique repair',
			backupPath: null,
			stampWarning: null,
			migrationOutput: '',
		}
	}

	let backupPath = null

	try {
		backupPath = createDesktopDatabaseBackup(runtimeDbPath, userDataDir, 'inventory-branch-unique')

		await withDesktopPrismaClient(async (prisma) => {
			const statements = [
				`UPDATE "inventory_items"
				 SET "branchId" = (
				 	SELECT rb."id"
				 	FROM "restaurant_branches" rb
				 	WHERE rb."restaurantId" = "inventory_items"."restaurantId"
				 	  AND rb."isMain" = 1
				 	  AND rb."isActive" = 1
				 	ORDER BY rb."createdAt" ASC
				 	LIMIT 1
				 )
				 WHERE "branchId" IS NULL
				   AND "restaurantId" IS NOT NULL`,
				`UPDATE "inventory_items"
				 SET "branchId" = (
				 	SELECT rb."id"
				 	FROM "restaurant_branches" rb
				 	WHERE rb."restaurantId" = "inventory_items"."restaurantId"
				 	  AND rb."isActive" = 1
				 	ORDER BY rb."sortOrder" ASC, rb."createdAt" ASC
				 	LIMIT 1
				 )
				 WHERE "branchId" IS NULL
				   AND "restaurantId" IS NOT NULL`,
				`DROP INDEX IF EXISTS "inventory_items_userId_name_key"`,
				`CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_userId_restaurantId_branchId_name_key"
				 ON "inventory_items"("userId", "restaurantId", "branchId", "name")`,
				`UPDATE "dishes"
				 SET "branchId" = (
				 	SELECT rb."id"
				 	FROM "restaurant_branches" rb
				 	WHERE rb."restaurantId" = "dishes"."restaurantId"
				 	  AND rb."isMain" = 1
				 	  AND rb."isActive" = 1
				 	ORDER BY rb."createdAt" ASC
				 	LIMIT 1
				 )
				 WHERE "branchId" IS NULL
				   AND "restaurantId" IS NOT NULL`,
				`UPDATE "dishes"
				 SET "branchId" = (
				 	SELECT rb."id"
				 	FROM "restaurant_branches" rb
				 	WHERE rb."restaurantId" = "dishes"."restaurantId"
				 	  AND rb."isActive" = 1
				 	ORDER BY rb."sortOrder" ASC, rb."createdAt" ASC
				 	LIMIT 1
				 )
				 WHERE "branchId" IS NULL
				   AND "restaurantId" IS NOT NULL`,
				`DROP INDEX IF EXISTS "dishes_userId_name_key"`,
				`CREATE UNIQUE INDEX IF NOT EXISTS "dishes_userId_restaurantId_branchId_name_key"
				 ON "dishes"("userId", "restaurantId", "branchId", "name")`,
			]

			for (const statement of statements) {
				await prisma.$executeRawUnsafe(statement)
			}
		})

		let stampWarning = null
		try {
			await stampAppliedDesktopMigrations(migrationsDir, DESKTOP_INVENTORY_BRANCH_SCOPED_UNIQUE_MIGRATION)
		} catch (stampError) {
			stampWarning = stampError?.message || String(stampError)
		}

		return {
			attempted: true,
			repaired: true,
			reason: 'Applied idempotent repair for inventory/dish branch-scoped unique indexes',
			backupPath,
			stampWarning,
			migrationOutput: 'Applied idempotent repair for inventory/dish branch-scoped unique indexes',
		}
	} catch (error) {
		return {
			attempted: true,
			repaired: false,
			reason: error?.message || String(error),
			backupPath,
			stampWarning: null,
			migrationOutput: '',
		}
	}
}

async function attemptLegacyDesktopBranchRepair({ migrationsDir, runPrismaCommand, userDataDir, runtimeDbPath }) {
	const inspection = await inspectLegacyDesktopBranchRepairState()
	if (!inspection.canRepair) {
		return {
			attempted: false,
			repaired: false,
			reason: inspection.reason,
			duplicateGroups: inspection.duplicateGroups,
			backupPath: null,
			baselineWarning: null,
			migrationOutput: '',
		}
	}

	if (!migrationsDir || !fs.existsSync(migrationsDir)) {
		return {
			attempted: true,
			repaired: false,
			reason: 'Packaged migration directory is unavailable for legacy repair',
			duplicateGroups: inspection.duplicateGroups,
			backupPath: null,
			baselineWarning: null,
			migrationOutput: '',
		}
	}

	const branchMigrationPath = path.join(migrationsDir, DESKTOP_BRANCH_FOUNDATION_MIGRATION, 'migration.sql')
	if (!fs.existsSync(branchMigrationPath)) {
		return {
			attempted: true,
			repaired: false,
			reason: `Missing packaged branch migration at ${branchMigrationPath}`,
			duplicateGroups: inspection.duplicateGroups,
			backupPath: null,
			baselineWarning: null,
			migrationOutput: '',
		}
	}

	let backupPath = null

	try {
		backupPath = createDesktopDatabaseBackup(runtimeDbPath, userDataDir, 'branch-foundation')
		const migrationOutput = runPrismaCommand(`db execute --file "${branchMigrationPath}"`)
		let baselineWarning = null

		try {
			await stampAppliedDesktopMigrations(migrationsDir, DESKTOP_BRANCH_FOUNDATION_MIGRATION)
		} catch (baselineError) {
			baselineWarning = baselineError?.message || String(baselineError)
		}

		return {
			attempted: true,
			repaired: true,
			reason: inspection.reason,
			duplicateGroups: inspection.duplicateGroups,
			backupPath,
			baselineWarning,
			migrationOutput,
		}
	} catch (error) {
		const stderr = error?.stderr ? error.stderr.toString() : ''
		const stdout = error?.stdout ? error.stdout.toString() : ''
		return {
			attempted: true,
			repaired: false,
			reason: `${error?.message || 'Unknown legacy repair error'}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`,
			duplicateGroups: inspection.duplicateGroups,
			backupPath,
			baselineWarning: null,
			migrationOutput: '',
		}
	}
}

function findAvailablePort(startPort) {
	return new Promise((resolve) => {
		function tryPort(port) {
			const tester = net.createServer()
			tester.once('error', () => {
				tryPort(port + 1)
			})
			tester.once('listening', () => {
				tester.close(() => resolve(port))
			})
			tester.listen(port, '0.0.0.0')
		}

		tryPort(startPort)
	})
}

function parseDbHostPort(databaseUrl) {
	try {
		const url = new URL(databaseUrl)
		return { host: url.hostname, port: parseInt(url.port || '5432', 10) }
	} catch {
		return null
	}
}

function probeTcpConnectivity(host, port, timeoutMs) {
	return new Promise((resolve) => {
		const socket = new net.Socket()
		let settled = false

		function done(result) {
			if (settled) return
			settled = true
			socket.destroy()
			resolve(result)
		}

		socket.setTimeout(timeoutMs)
		socket.once('connect', () => done(true))
		socket.once('timeout', () => done(false))
		socket.once('error', () => done(false))
		socket.connect(port, host)
	})
}

// Resolve icon path — works both in dev and packaged
function getIconPath() {
	const candidates = [
		path.join(__dirname, '..', 'public', 'icon.ico'),
		path.join(__dirname, '..', 'public', 'icon.png'),
		path.join(process.resourcesPath || '', 'app', 'public', 'icon.ico'),
	]
	for (const p of candidates) {
		if (fs.existsSync(p)) return p
	}
	return undefined
}

function getLoadingIconPath() {
	const candidates = [
		path.join(__dirname, '..', 'public', 'icon.png'),
		path.join(__dirname, '..', 'public', 'icon.svg'),
		path.join(__dirname, '..', 'public', 'icon.ico'),
	]
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate
	}
	return getIconPath()
}

// Single instance lock
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
	app.quit()
}

let mainWindow
let loadingWindow

function getLocalIP() {
	const interfaces = os.networkInterfaces()
	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name]) {
			if (iface.family === 'IPv4' && !iface.internal) {
				return iface.address
			}
		}
	}
	return 'localhost'
}

function createLoadingWindow() {
	const loadingIconPath = getLoadingIconPath()
	const loadingIconMime = loadingIconPath
		? path.extname(loadingIconPath).toLowerCase() === '.svg'
			? 'svg+xml'
			: path.extname(loadingIconPath).toLowerCase() === '.ico'
				? 'x-icon'
				: 'png'
		: null
	const loadingIconSrc = loadingIconPath
		? `data:image/${loadingIconMime};base64,${fs.readFileSync(loadingIconPath).toString('base64')}`
		: null

	loadingWindow = new BrowserWindow({
		width: 420,
		height: 320,
		frame: false,
		transparent: false,
		resizable: false,
		center: true,
		alwaysOnTop: true,
		icon: getIconPath(),
		webPreferences: { nodeIntegration: true, contextIsolation: false }
	})
	loadingWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
		<html>
		<body style="margin:0;background:#111827;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:white;">
			${loadingIconSrc ? `<img src="${loadingIconSrc}" alt="Magnify" style="width:72px;height:72px;border-radius:18px;object-fit:cover;margin-bottom:16px;box-shadow:0 10px 30px rgba(249,115,22,0.28);" />` : '<div style="font-size:48px;margin-bottom:16px">🍽️</div>'}
			<div style="font-size:22px;font-weight:bold;margin-bottom:4px">Magnify</div>
			<div style="font-size:13px;color:#f97316;font-weight:600;margin-bottom:16px">Restaurant</div>
			<div style="font-size:13px;color:#9ca3af;margin-bottom:24px">Starting server, please wait...</div>
			<div style="width:200px;height:4px;background:#374151;border-radius:4px;overflow:hidden">
				<div style="width:40%;height:100%;background:linear-gradient(to right,#f97316,#dc2626);border-radius:4px;animation:slide 1.2s ease-in-out infinite" id="bar"></div>
			</div>
			<style>@keyframes slide{0%{margin-left:-40%}100%{margin-left:100%}}</style>
		</body>
		</html>
	`))
}

function createWindow(localIP, serverPort) {
	mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		show: false,
		icon: getIconPath(),
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			preload: path.join(__dirname, 'preload.js'),
		},
		title: 'Magnify — Restaurant',
		autoHideMenuBar: true
	})

	mainWindow.loadURL(`http://localhost:${serverPort}`)
	mainWindow.maximize()

	// Open external links (target="_blank") in the system browser, not a child Electron window
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
			return { action: 'allow' }
		}
		shell.openExternal(url)
		return { action: 'deny' }
	})

	mainWindow.once('ready-to-show', () => {
		if (loadingWindow) {
			loadingWindow.close()
			loadingWindow = null
		}

		// Compensate for Windows display scaling so the layout renders at its true
		// design size (same as the web app at 100%). Fully neutralising the OS scale
		// (factor 1.0) keeps the sidebar and content from overflowing on 125%/150%
		// displays — the previous 1.25 factor left everything ~25% oversized, which
		// pushed the sidebar past the viewport height and forced scrolling.
		try {
			const scaleFactor = screen.getPrimaryDisplay().scaleFactor
			if (scaleFactor > 1) {
				const zoomFactor = parseFloat((1.0 / scaleFactor).toFixed(4))
				mainWindow.webContents.setZoomFactor(zoomFactor)
				appendStartupLog(`Display scale=${scaleFactor} → zoom compensated to ${zoomFactor}`)
			}
		} catch (e) {
			appendStartupLog(`Display scale compensation failed: ${e?.message}`)
		}

		// Show "Updated successfully" toast if the previous launch triggered an update install
		try {
			const justUpdatedPath = path.join(app.getPath('userData'), 'just-updated.json')
			if (fs.existsSync(justUpdatedPath)) {
				const flagData = JSON.parse(fs.readFileSync(justUpdatedPath, 'utf8'))
				fs.unlinkSync(justUpdatedPath)
				const newVer = flagData.version ? ` to v${flagData.version}` : ''
				appendStartupLog(`Showing post-update toast for version ${flagData.version || 'unknown'}`)
				// Delay so Next.js app finishes mounting before we inject the banner
				setTimeout(() => {
					showInAppBanner(
						'<div style="' + bannerStyles.replace('border-left:4px solid #f97316', 'border-left:4px solid #22c55e') + '">' +
							'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
								'<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="10" fill="#22c55e"/><path d="M6 10l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
								'<span style="font-weight:600;font-size:14px;color:#15803d;">Magnify updated' + newVer + '</span>' +
							'</div>' +
							'<div style="color:#6b7280;font-size:13px;">The app is running the latest version.</div>' +
							'<div style="margin-top:10px;text-align:right;">' +
								'<button onclick="document.getElementById(\'magnify-update-banner\').remove()" style="padding:4px 14px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#374151;font-size:12px;cursor:pointer;font-weight:500;">Dismiss</button>' +
							'</div>' +
						'</div>'
					)
				}, 3500)
			}
		} catch (e) {
			appendStartupLog(`Post-update toast failed: ${e?.message}`)
		}

		mainWindow.show()

		startDesktopUpdateChecks()
	})

	mainWindow.on('closed', () => {
		mainWindow = null
	})
}

function createMaintenanceWindow(message) {
	if (loadingWindow) {
		loadingWindow.close()
		loadingWindow = null
	}

	mainWindow = new BrowserWindow({
		width: 920,
		height: 680,
		show: false,
		icon: getIconPath(),
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
		},
		title: 'Magnify Maintenance Mode',
		autoHideMenuBar: true,
	})

	mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
		<html>
		<body style="margin:0;background:#111827;color:#f9fafb;font-family:Segoe UI,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;">
			<div style="max-width:680px;background:#1f2937;border:1px solid #374151;border-radius:20px;padding:32px;box-shadow:0 20px 60px rgba(0,0,0,0.35);">
				<div style="font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#f97316;margin-bottom:14px;">Maintenance Mode</div>
				<h1 style="font-size:28px;line-height:1.2;margin:0 0 12px;">Magnify needs recovery before normal startup.</h1>
				<p style="font-size:15px;line-height:1.7;color:#d1d5db;margin:0 0 18px;">The local schema or bootstrap state could not be finalized safely, so the app stayed in maintenance mode instead of continuing with partial data.</p>
				<pre style="white-space:pre-wrap;background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:16px;color:#e5e7eb;font-size:13px;line-height:1.6;">${String(message || 'Unknown bootstrap failure')}</pre>
				<p style="font-size:13px;line-height:1.6;color:#9ca3af;margin:18px 0 0;">Check the startup and migration logs in your app data folder before restarting the app.</p>
			</div>
		</body>
		</html>
	`))

	mainWindow.once('ready-to-show', () => {
		mainWindow.show()
	})

	mainWindow.on('closed', () => {
		mainWindow = null
	})
}

function createOfflineWindow() {
	if (loadingWindow) {
		loadingWindow.close()
		loadingWindow = null
	}

	mainWindow = new BrowserWindow({
		width: 820,
		height: 560,
		show: false,
		icon: getIconPath(),
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
		},
		title: 'Magnify — No Internet',
		autoHideMenuBar: true,
	})

	mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
		<html>
		<body style="margin:0;background:#111827;color:#f9fafb;font-family:Segoe UI,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:32px;box-sizing:border-box;">
			<div style="max-width:540px;width:100%;text-align:center;">
				<div style="width:60px;height:60px;background:#1f2937;border:1px solid #374151;border-radius:16px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:20px;">
					<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<line x1="2" y1="2" x2="22" y2="22"></line>
						<path d="M8.5 16.5a5 5 0 0 1 7 0"></path>
						<path d="M2 8.82a15 15 0 0 1 4.17-2.65"></path>
						<path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"></path>
						<path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"></path>
						<path d="M5 12.5A10 10 0 0 1 7.5 11"></path>
						<circle cx="12" cy="20" r="1" fill="#6b7280"></circle>
					</svg>
				</div>
				<div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#6b7280;margin-bottom:10px;">No Internet Connection</div>
				<h1 style="font-size:24px;font-weight:700;margin:0 0 12px;line-height:1.3;">Manager portal is offline</h1>
				<p style="font-size:14px;color:#9ca3af;line-height:1.7;margin:0 0 24px;">
					The manager portal needs an internet connection to reach the cloud database.
					Check your connection and tap Try Again.
				</p>
				<div style="background:#1f2937;border:1px solid #374151;border-radius:14px;padding:20px 22px;margin-bottom:28px;text-align:left;">
					<div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#f97316;margin-bottom:8px;">Waiters can keep working</div>
					<p style="font-size:13px;color:#d1d5db;line-height:1.65;margin:0;">
						The Waiter App works fully offline — tables and orders continue as normal.
						Once the manager comes back online, live view and reports will update automatically.
					</p>
				</div>
				<button
					id="retryBtn"
					onclick="this.disabled=true;this.textContent='Checking...';this.style.opacity='0.6';require('electron').ipcRenderer.send('offline-retry')"
					style="padding:11px 32px;background:#f97316;color:#fff;border:none;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer;letter-spacing:0.02em;">
					Try Again
				</button>
			</div>
		</body>
		</html>
	`))

	mainWindow.once('ready-to-show', () => {
		mainWindow.show()
	})

	mainWindow.on('closed', () => {
		mainWindow = null
	})
}

ipcMain.on('offline-retry', () => {
	if (offlineRetryCallback) offlineRetryCallback()
})

// ─── Thermal printer support ──────────────────────────────────────────────────

const PRINTER_SETTINGS_PATH = () => path.join(app.getPath('userData'), 'printer-settings.json')

const DEFAULT_PRINTER_SETTINGS = {
	enabled: false,
	type: 'system',
	printerName: '',
	networkHost: '',
	networkPort: 9100,
}

function loadPrinterSettings() {
	try {
		const raw = fs.readFileSync(PRINTER_SETTINGS_PATH(), 'utf8')
		return { ...DEFAULT_PRINTER_SETTINGS, ...JSON.parse(raw) }
	} catch {
		return { ...DEFAULT_PRINTER_SETTINGS }
	}
}

function savePrinterSettings(settings) {
	fs.writeFileSync(PRINTER_SETTINGS_PATH(), JSON.stringify(settings, null, 2), 'utf8')
}

function escHtml(str) {
	return String(str || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}

function buildKitchenTicketHtml(data) {
	const rows = data.items.map(item => `
		<div class="item">
			<span class="qty">${item.qty}x</span>
			<span class="name">${escHtml(item.dishName)}</span>
		</div>
		${item.notes ? `<div class="note">&gt; ${escHtml(item.notes)}</div>` : ''}
	`).join('')

	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:14px; width:280px; margin:0 auto; padding:8px; }
  .center { text-align:center; }
  .title { font-size:20px; font-weight:bold; margin-bottom:4px; }
  .divider { border-top:1px dashed #000; margin:6px 0; }
  .meta { font-size:12px; margin:2px 0; }
  .item { display:flex; gap:8px; margin:4px 0; font-weight:bold; }
  .qty { min-width:26px; }
  .note { margin-left:32px; font-style:italic; font-size:12px; margin-bottom:4px; }
  @media print { @page { margin:0; size:80mm auto; } }
</style></head>
<body>
  <div class="center">
    <div class="title">${escHtml(data.branchType === 'bar' ? 'BAR' : 'KITCHEN')}</div>
    <div>Order #${escHtml(data.orderNumber)}</div>
  </div>
  <div class="divider"></div>
  <div class="meta">Table : ${escHtml(data.tableName)}</div>
  <div class="meta">Time  : ${escHtml(data.time)}</div>
  <div class="divider"></div>
  ${rows}
  <div class="divider"></div>
  <div class="meta">Waiter: ${escHtml(data.waiterName)}</div>
</body></html>`
}

function buildKitchenTicketEscPos(data) {
	const parts = []
	const t = s => Buffer.from(s, 'utf8')
	const b = bytes => Buffer.from(bytes)
	const ESC = 0x1B, GS = 0x1D

	parts.push(b([ESC, 0x40]))           // Initialize
	parts.push(b([ESC, 0x61, 0x01]))     // Center
	parts.push(b([ESC, 0x45, 0x01]))     // Bold ON
	parts.push(b([ESC, 0x21, 0x11]))     // Double height
	parts.push(t(data.branchType === 'bar' ? 'BAR\n' : 'KITCHEN\n'))
	parts.push(b([ESC, 0x21, 0x00]))     // Normal size
	parts.push(t(`Order #${data.orderNumber}\n`))
	parts.push(b([ESC, 0x45, 0x00]))     // Bold OFF
	parts.push(b([ESC, 0x61, 0x00]))     // Left align
	parts.push(t('--------------------------------\n'))
	parts.push(t(`Table : ${data.tableName}\n`))
	parts.push(t(`Time  : ${data.time}\n`))
	parts.push(t('--------------------------------\n'))

	for (const item of data.items) {
		parts.push(b([ESC, 0x45, 0x01]))   // Bold ON
		parts.push(t(`${item.qty}x  ${item.dishName}\n`))
		parts.push(b([ESC, 0x45, 0x00]))   // Bold OFF
		if (item.notes) parts.push(t(`    > ${item.notes}\n`))
	}

	parts.push(t('--------------------------------\n'))
	parts.push(t(`Waiter: ${data.waiterName}\n`))
	parts.push(t('\n\n\n'))
	parts.push(b([GS, 0x56, 0x00]))      // Full cut

	return Buffer.concat(parts)
}

function printViaSystemPrinter(printerName, htmlContent) {
	return new Promise((resolve, reject) => {
		const win = new BrowserWindow({
			show: false,
			webPreferences: { nodeIntegration: false, contextIsolation: true },
		})
		win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent))
		win.webContents.once('did-finish-load', () => {
			win.webContents.print(
				{ silent: true, deviceName: printerName, printBackground: true },
				(success, err) => {
					win.destroy()
					if (success) resolve(true)
					else reject(new Error(err || 'print failed'))
				}
			)
		})
	})
}

function printViaNetwork(host, port, buffer) {
	return new Promise((resolve, reject) => {
		const socket = new net.Socket()
		const timer = setTimeout(() => {
			socket.destroy()
			reject(new Error('Network printer timed out'))
		}, 5000)
		socket.connect(Number(port), host, () => {
			socket.write(buffer, () => {
				clearTimeout(timer)
				socket.end()
				resolve(true)
			})
		})
		socket.on('error', err => {
			clearTimeout(timer)
			reject(err)
		})
	})
}

ipcMain.handle('files:save-and-reveal', async (_, { filename, dataBase64 }) => {
	try {
		const downloadsDir = app.getPath('downloads')
		const ext = path.extname(filename)
		const base = path.basename(filename, ext)

		let candidate = filename
		let n = 1
		while (fs.existsSync(path.join(downloadsDir, candidate))) {
			candidate = `${base} (${n})${ext}`
			n += 1
		}

		const fullPath = path.join(downloadsDir, candidate)
		fs.writeFileSync(fullPath, Buffer.from(dataBase64, 'base64'))
		shell.showItemInFolder(fullPath)
		return { ok: true, path: fullPath }
	} catch (e) {
		return { ok: false, reason: e.message }
	}
})

ipcMain.handle('printer:list-system', async () => {
	try {
		const printers = await mainWindow.webContents.getPrintersAsync()
		return printers.map(p => ({ name: p.name, isDefault: p.isDefault }))
	} catch {
		return []
	}
})

ipcMain.handle('printer:get-settings', () => loadPrinterSettings())

ipcMain.handle('printer:save-settings', (_, settings) => {
	savePrinterSettings(settings)
	return true
})

ipcMain.handle('printer:print-kitchen', async (_, data) => {
	const settings = loadPrinterSettings()
	if (!settings.enabled) return { ok: false, reason: 'Printer not enabled' }
	try {
		if (settings.type === 'network') {
			await printViaNetwork(settings.networkHost, settings.networkPort, buildKitchenTicketEscPos(data))
		} else {
			await printViaSystemPrinter(settings.printerName, buildKitchenTicketHtml(data))
		}
		return { ok: true }
	} catch (e) {
		return { ok: false, reason: e.message }
	}
})

ipcMain.handle('printer:print-bill', async (_, html) => {
	const settings = loadPrinterSettings()
	if (!settings.enabled) return { ok: false, reason: 'Printer not enabled' }
	if (settings.type === 'network') return { ok: false, reason: 'Bill printing requires a system printer' }
	try {
		await printViaSystemPrinter(settings.printerName, html)
		return { ok: true }
	} catch (e) {
		return { ok: false, reason: e.message }
	}
})

ipcMain.handle('printer:test', async () => {
	const settings = loadPrinterSettings()
	const testData = {
		branchType: 'kitchen', orderNumber: 'TEST', tableName: 'Table 1',
		time: new Date().toLocaleTimeString(), waiterName: 'System Test',
		items: [{ qty: 2, dishName: 'Smash Burger', notes: 'medium rare' }, { qty: 1, dishName: 'Fries', notes: '' }],
	}
	try {
		if (settings.type === 'network') {
			await printViaNetwork(settings.networkHost, settings.networkPort, buildKitchenTicketEscPos(testData))
		} else {
			await printViaSystemPrinter(settings.printerName, buildKitchenTicketHtml(testData))
		}
		return { ok: true }
	} catch (e) {
		return { ok: false, reason: e.message }
	}
})

// ─────────────────────────────────────────────────────────────────────────────

getAutoUpdater()?.on('checking-for-update', () => {
	appendStartupLog('Electron updater: checking for update')
})

function showInAppBanner(html) {
	if (!mainWindow) return
	const js = `
		(function() {
			var existing = document.getElementById('magnify-update-banner');
			if (existing) existing.remove();
			var div = document.createElement('div');
			div.id = 'magnify-update-banner';
			div.innerHTML = ${JSON.stringify('`' + '${html}' + '`')};
			document.body.appendChild(div);
		})();
	`.replace('${html}', html)
	mainWindow.webContents.executeJavaScript(js).catch(() => {})
}

function dismissBanner() {
	if (!mainWindow) return
	mainWindow.webContents.executeJavaScript(`
		var b = document.getElementById('magnify-update-banner');
		if (b) b.remove();
	`).catch(() => {})
}

function showOfflineFallbackBanner() {
	if (!mainWindow) return
	const js = `
		(function() {
			if (document.getElementById('magnify-offline-banner')) return;
			var bar = document.createElement('div');
			bar.id = 'magnify-offline-banner';
			bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fffbeb;border-bottom:2px solid #f59e0b;padding:9px 20px;display:flex;align-items:center;justify-content:space-between;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:13px;color:#92400e;';
			bar.innerHTML = '<div style="display:flex;align-items:center;gap:9px;">'
				+ '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
				+ '<span><strong>Working offline</strong> — Using local data. Changes won\\'t sync to the cloud until you reconnect and restart.</span>'
				+ '</div>'
				+ '<button onclick="document.getElementById(\\'magnify-offline-banner\\').remove()" style="margin-left:16px;padding:3px 12px;border:1px solid #d97706;border-radius:5px;background:#fef3c7;color:#92400e;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;">Dismiss</button>';
			document.body.prepend(bar);
		})();
	`
	mainWindow.webContents.executeJavaScript(js).catch(() => {})
}

const bannerStyles = 'position:fixed;bottom:24px;right:24px;z-index:99999;background:#fff;border:1px solid #e5e7eb;border-left:4px solid #f97316;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,0.12);padding:16px 20px;max-width:370px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111827;line-height:1.5;'

let pendingUpdateVersion = ''
function showDownloadingBanner(version) {
	showInAppBanner(
		'<div style="' + bannerStyles + '">' +
			'<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
				'<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="10" fill="#f97316"/><path d="M10 5v6M10 13.5v1" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>' +
				'<span style="font-weight:600;font-size:15px;">Update Downloading</span>' +
			'</div>' +
			'<div style="color:#4b5563;">A new version' + version + ' is downloading in the background.</div>' +
			'<div id="magnify-update-progress" style="margin-top:10px;height:4px;background:#f3f4f6;border-radius:2px;overflow:hidden;">' +
				'<div id="magnify-update-progress-bar" style="height:100%;width:0%;background:#f97316;border-radius:2px;transition:width 0.3s;"></div>' +
			'</div>' +
		'</div>'
	)
}

getAutoUpdater()?.on('update-available', (info) => {
	appendStartupLog(`Electron updater: update available ${info?.version || 'unknown'}`)
	pendingUpdateVersion = info?.version ? ' v' + info.version : ''
	showDownloadingBanner(pendingUpdateVersion)
})

getAutoUpdater()?.on('update-not-available', (info) => {
	appendStartupLog(`Electron updater: no update available (current ${app.getVersion()}, latest ${info?.version || app.getVersion()})`)
})

getAutoUpdater()?.on('download-progress', (progress) => {
	const pct = Math.round(progress.percent || 0)
	appendStartupLog(`Electron updater: download ${pct}%`)
	if (!mainWindow) return
	// If banner isn't visible yet (page wasn't ready when update-available fired), show it now
	mainWindow.webContents.executeJavaScript(`
		document.getElementById('magnify-update-banner') ? true : false
	`).then((exists) => {
		if (!exists) showDownloadingBanner(pendingUpdateVersion)
		else mainWindow.webContents.executeJavaScript(`
			var bar = document.getElementById('magnify-update-progress-bar');
			if (bar) bar.style.width = '${pct}%';
		`).catch(() => {})
	}).catch(() => {})
})

getAutoUpdater()?.on('error', (error) => {
	appendStartupLog(`Electron updater error: ${error?.message || error}`)
})

// Prompt user to restart when an update has finished downloading
getAutoUpdater()?.on('update-downloaded', () => {
	desktopUpdateDownloaded = true
	clearDesktopUpdateSchedule()
	appendStartupLog('Electron updater: update downloaded')
	showInAppBanner(
		'<div style="' + bannerStyles + '">' +
			'<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
				'<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="10" fill="#22c55e"/><path d="M6 10l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
				'<span style="font-weight:600;font-size:15px;">Update Ready</span>' +
			'</div>' +
			'<div style="color:#4b5563;margin-bottom:12px;">A new version has been downloaded. Restart to apply.</div>' +
			'<div style="display:flex;gap:8px;justify-content:flex-end;">' +
				'<button onclick="document.getElementById(\'magnify-update-banner\').remove()" style="padding:6px 16px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#374151;font-size:13px;cursor:pointer;font-weight:500;">Later</button>' +
				'<button id="magnify-restart-btn" style="padding:6px 16px;border:none;border-radius:6px;background:#f97316;color:#fff;font-size:13px;cursor:pointer;font-weight:500;">Restart Now</button>' +
			'</div>' +
		'</div>'
	)
	// Listen for the restart click
	if (mainWindow) {
		mainWindow.webContents.executeJavaScript(`
			var btn = document.getElementById('magnify-restart-btn');
			if (btn) btn.addEventListener('click', function() {
				fetch('/api/config', { method: 'HEAD' }).catch(function(){});
				document.getElementById('magnify-update-banner').innerHTML =
					'<div style="${bannerStyles.replace(/'/g, "\\'")}"><div style="color:#4b5563;">Restarting...</div></div>';
			});
		`).catch(() => {})
		// Poll for the click (no IPC available)
		const restartPoll = setInterval(() => {
			if (!mainWindow) { clearInterval(restartPoll); return }
			mainWindow.webContents.executeJavaScript(`
				document.getElementById('magnify-update-banner')?.textContent?.includes('Restarting') || false
			`).then((restarting) => {
				if (restarting) {
					clearInterval(restartPoll)
					// Write flag so the next launch shows "Updated successfully" toast
					try {
						const flagPath = path.join(app.getPath('userData'), 'just-updated.json')
						const newVersion = String(pendingUpdateVersion || '').replace(/^\s*v/i, '').trim()
						fs.writeFileSync(flagPath, JSON.stringify({ version: newVersion }), 'utf8')
					} catch {}
					getAutoUpdater()?.quitAndInstall()
				}
			}).catch(() => clearInterval(restartPoll))
		}, 500)
		// Stop polling after 10 minutes (user chose "Later" or ignored it)
		setTimeout(() => clearInterval(restartPoll), 600000)
	}
})

app.whenReady().then(async () => {
	createLoadingWindow()

	const appDir = path.join(__dirname, '..')
	process.env.NODE_ENV = 'production'
	try {
		fs.writeFileSync(getStartupLogPath(), '', 'utf8')
	} catch {
		// Ignore log bootstrap issues.
	}
	appendStartupLog(`App starting. appDir=${appDir}`)
	appendStartupLog(`App version=${app.getVersion()} execPath=${process.execPath}`)
	appendStartupLog(`App packaged=${app.isPackaged} resourcesPath=${process.resourcesPath || ''}`)

	function hasConfiguredGeminiKeys() {
		return Object.entries(process.env).some(([key, value]) => /^GEMINI_API_KEY(?:S|(?:_\d+)?)?$/.test(key) && typeof value === 'string' && value.trim())
	}

	function loadEnvFile(filePath, options = {}) {
		if (!fs.existsSync(filePath)) return
		const skipGemini = options.skipGemini === true
		const envContent = fs.readFileSync(filePath, 'utf8')
		for (const line of envContent.split('\n')) {
			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith('#')) continue
			const eqIdx = trimmed.indexOf('=')
			if (eqIdx === -1) continue
			const key = trimmed.slice(0, eqIdx).trim()
			if (skipGemini && key.startsWith('GEMINI_')) continue
			const val = trimmed.slice(eqIdx + 1).trim().replace(/^"|"$/g, '')
			if (!process.env[key]) process.env[key] = val
		}
	}

	// Prefer active local config first, then use runtime.env only as a fallback.
	appendStartupLog(`Runtime env present=${fs.existsSync(path.join(__dirname, 'runtime.env'))}`)
	loadEnvFile(path.join(appDir, '.env.local'))
	loadEnvFile(path.join(appDir, '.env'))
	const skipRuntimeGemini = hasConfiguredGeminiKeys()
	appendStartupLog(`Runtime Gemini keys skipped=${skipRuntimeGemini}`)
	loadEnvFile(path.join(__dirname, 'runtime.env'), { skipGemini: skipRuntimeGemini })

	// NEXTAUTH_SECRET must never be bundled in the package (extractable from .exe).
	// Generate a stable per-device secret on first launch and persist it in userData.
	if (!process.env.NEXTAUTH_SECRET) {
		const secretPath = path.join(app.getPath('userData'), 'auth.secret')
		let deviceSecret
		if (fs.existsSync(secretPath)) {
			deviceSecret = fs.readFileSync(secretPath, 'utf8').trim()
		} else {
			deviceSecret = randomBytes(32).toString('hex')
			fs.mkdirSync(path.dirname(secretPath), { recursive: true })
			fs.writeFileSync(secretPath, deviceSecret, { encoding: 'utf8', mode: 0o600 })
		}
		process.env.NEXTAUTH_SECRET = deviceSecret
		appendStartupLog('NEXTAUTH_SECRET loaded from device secret store')
	}

	// Load OWNER_SYNC_SHARED_SECRET from userData/sync.secret if it was configured post-install.
	// The secret is never bundled in the package; the Settings UI writes it via the desktop API.
	if (!process.env.OWNER_SYNC_SHARED_SECRET) {
		const syncSecretPath = path.join(app.getPath('userData'), 'sync.secret')
		if (fs.existsSync(syncSecretPath)) {
			try {
				const storedSecret = fs.readFileSync(syncSecretPath, 'utf8').trim()
				if (storedSecret) {
					process.env.OWNER_SYNC_SHARED_SECRET = storedSecret
					appendStartupLog('OWNER_SYNC_SHARED_SECRET loaded from device sync secret store')
				}
			} catch {
				// Best-effort; proceed without the secret if the file is unreadable.
				appendStartupLog('OWNER_SYNC_SHARED_SECRET: sync.secret file unreadable, skipping')
			}
		} else {
			appendStartupLog('OWNER_SYNC_SHARED_SECRET: not configured (use Settings › Owner cloud sync to configure)')
		}
	}

	const configuredDatabaseUrl = String(process.env.DATABASE_URL || '')
	const hasCloudDatabaseUrl = configuredDatabaseUrl.startsWith('postgresql://') || configuredDatabaseUrl.startsWith('postgres://')
	const electronDataMode = normalizeElectronDataMode(process.env.ELECTRON_DATA_MODE || 'cloud')
	appendStartupLog(`Electron data mode=${electronDataMode}`)

	// Probe cloud database reachability before starting the server.
	// The cloud build uses a PostgreSQL Prisma client that cannot fall back to SQLite,
	// so if the database is unreachable we show the offline window immediately and skip
	// the Next.js server entirely.  The retry handler re-probes and relaunches cleanly.
	if (app.isPackaged && hasCloudDatabaseUrl && electronDataMode === 'cloud') {
		const neonHostPort = parseDbHostPort(configuredDatabaseUrl)
		if (neonHostPort) {
			appendStartupLog(`Probing cloud database at ${neonHostPort.host}:${neonHostPort.port} (timeout 4s)`)
			const reachable = await probeTcpConnectivity(neonHostPort.host, neonHostPort.port, 4000)
			if (reachable) {
				appendStartupLog('Cloud database reachable — using cloud mode')
			} else {
				isOfflineFallback = true
				appendStartupLog('Cloud database unreachable — showing offline window without starting server')
				offlineRetryCallback = async () => {
					appendStartupLog('Offline retry: re-probing cloud database connectivity')
					let retryReachable = false
					try {
						retryReachable = await probeTcpConnectivity(neonHostPort.host, neonHostPort.port, 4000)
					} catch { /* ignore probe errors */ }
					appendStartupLog(`Offline retry: probe result=${retryReachable}`)
					if (!retryReachable) {
						appendStartupLog('Offline retry: still unreachable')
						createOfflineWindow()
						return
					}
					appendStartupLog('Offline retry: database reachable — relaunching app')
					app.relaunch()
					app.exit(0)
				}
				createOfflineWindow()
				return
			}
		} else {
			appendStartupLog('Could not parse cloud database host — proceeding with cloud mode')
		}
	}

	const shouldUseLocalDatabase = !hasCloudDatabaseUrl || (app.isPackaged && electronDataMode !== 'cloud')
	appendStartupLog(`Database mode=${shouldUseLocalDatabase ? 'local-sqlite' : 'cloud-postgres'}`)

	// Detect local IP and set NEXTAUTH_URL dynamically so session cookies work on LAN
	const localIP = getLocalIP()
	const serverPort = await findAvailablePort(3001)
	process.env.NEXTAUTH_URL = `http://${localIP}:${serverPort}`
	appendStartupLog(`Selected serverPort=${serverPort}`)
	let desktopRuntimeDbPath = null

	if (app.isPackaged && shouldUseLocalDatabase) {
		if (hasCloudDatabaseUrl && electronDataMode !== 'cloud') {
			appendStartupLog('Ignoring packaged cloud DATABASE_URL because desktop is running in local-first mode')
		}

		const bundledDbCandidates = [
			path.join(appDir, 'dev.db'),
			path.join(appDir, 'prisma', 'dev.db')
		]
		const bundledDbPath = bundledDbCandidates.find((dbPath) => fs.existsSync(dbPath))

		const runtimeDbDir = path.join(app.getPath('userData'), 'data')
		const runtimeDbPath = path.join(runtimeDbDir, 'dev.db')
		fs.mkdirSync(runtimeDbDir, { recursive: true })
		desktopRuntimeDbPath = runtimeDbPath

		if (!fs.existsSync(runtimeDbPath) && bundledDbPath) {
			fs.copyFileSync(bundledDbPath, runtimeDbPath)
		}

		const absoluteDbPath = runtimeDbPath.replace(/\\/g, '/')
		process.env.DATABASE_URL = `file:${absoluteDbPath}`
		console.log('Using DATABASE_URL:', process.env.DATABASE_URL)
		appendStartupLog(`Using packaged database at ${process.env.DATABASE_URL}`)
	} else if (app.isPackaged) {
		appendStartupLog('Using packaged cloud database configuration from env files')
	}

	let runDesktopPrismaCommand = null
	let desktopMigrationLogPath = null
	let desktopMigrationsDir = null

	function isRecoverableBootstrapSchemaError(message) {
		return /(does not exist in the current database|no such column|no such table|\bP2021\b|\bP2022\b)/i.test(String(message || ''))
	}

	function isNetworkConnectivityError(message) {
		return /(Can't reach database server|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|connection refused|connection timed out|getaddrinfo)/i.test(String(message || ''))
	}

	// Run local database migrations for packaged desktop installs.
	if (shouldUseLocalDatabase) {
		let migrationFailureMessage = null
		let migrationFailureShouldBlockStartup = false

		try {
			const { execFileSync } = require('child_process')
			const userDataDir = app.getPath('userData')
			const migrationLogPath = path.join(userDataDir, 'migration.log')
			const schemaPath = resolveRuntimeAsset(appDir, 'prisma', 'schema.prisma')
			const migrationsDir = resolveRuntimeAsset(appDir, 'prisma', 'migrations')
			const prismaJsEntrypoint = resolveRuntimeAsset(appDir, 'node_modules', 'prisma', 'build', 'index.js')
			fs.mkdirSync(userDataDir, { recursive: true })
			desktopMigrationLogPath = migrationLogPath
			desktopMigrationsDir = migrationsDir

			appendStartupLog(`Resolved migration schemaPath=${schemaPath || 'missing'}`)
			appendStartupLog(`Resolved migration migrationsDir=${migrationsDir || 'missing'}`)
			appendStartupLog(`Resolved migration prismaCli=${prismaJsEntrypoint || 'missing'}`)

			const missingAssets = [
				!schemaPath ? 'schema.prisma' : null,
				!migrationsDir ? 'prisma/migrations' : null,
				!prismaJsEntrypoint ? 'node_modules/prisma/build/index.js' : null,
			].filter(Boolean)

			if (missingAssets.length > 0) {
				migrationFailureMessage = `Desktop migrations cannot run because required packaged assets are missing: ${missingAssets.join(', ')}`
				migrationFailureShouldBlockStartup = true
				fs.writeFileSync(
					migrationLogPath,
					`[${new Date().toISOString()}] Migration skipped\n${migrationFailureMessage}`,
					'utf8'
				)
				appendStartupLog(migrationFailureMessage)
			} else {
				const migrationNodePaths = getBundledNodePaths(appDir)
				const migrationEnv = {
					...process.env,
					ELECTRON_RUN_AS_NODE: '1',
					NODE_PATH: [...migrationNodePaths, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
				}
				appendStartupLog(`Migration NODE_PATH=${migrationEnv.NODE_PATH}`)
				appendStartupLog(`Migration timeout=${DESKTOP_PRISMA_COMMAND_TIMEOUT_MS}ms`)

				const runPrismaCommand = (commandArgs) => {
					const args = [...commandArgs.split(/\s+/).filter(Boolean), '--schema', schemaPath]
					return execFileSync(process.execPath, [prismaJsEntrypoint, ...args], {
						cwd: userDataDir,
						env: migrationEnv,
						stdio: 'pipe',
						timeout: DESKTOP_PRISMA_COMMAND_TIMEOUT_MS,
						windowsHide: true,
					}).toString()
				}
				runDesktopPrismaCommand = runPrismaCommand
				const primaryDesktopSchemaCommand = 'db push --skip-generate --accept-data-loss'

				try {
					appendStartupLog(`Running desktop SQLite schema sync via ${primaryDesktopSchemaCommand}`)
					const migrationOutput = runPrismaCommand(primaryDesktopSchemaCommand)

					fs.writeFileSync(
						migrationLogPath,
						`[${new Date().toISOString()}] Schema sync succeeded\nCommand: ${primaryDesktopSchemaCommand}\n${migrationOutput}`,
						'utf8'
					)
					appendStartupLog('Database schema synchronized successfully')
					console.log('Database schema synchronized successfully')
				} catch (migrationErr) {
					const migrationStderr = migrationErr?.stderr ? migrationErr.stderr.toString() : ''
					const migrationStdout = migrationErr?.stdout ? migrationErr.stdout.toString() : ''
					const migrationDetails = `${migrationErr?.message || 'Unknown migration error'}\n\nSTDOUT:\n${migrationStdout}\n\nSTDERR:\n${migrationStderr}`

					if (/\bP3018\b/.test(migrationDetails) && /Migration name:\s*20260430000001_inventory_item_branch_scoped_unique/.test(migrationDetails) && /inventory_items_userId_restaurantId_branchId_name_key already exists/.test(migrationDetails)) {
						appendStartupLog('Migration reported duplicate inventory branch unique index; attempting idempotent repair')
						const uniqueRepair = await attemptInventoryBranchScopedUniqueRepair({
							migrationsDir,
							userDataDir,
							runtimeDbPath: desktopRuntimeDbPath,
						})

						if (uniqueRepair.repaired) {
							const repairLogLines = [
								`[${new Date().toISOString()}] Inventory branch unique repair succeeded`,
								uniqueRepair.backupPath ? `Backup: ${uniqueRepair.backupPath}` : null,
								uniqueRepair.stampWarning ? `Stamp warning: ${uniqueRepair.stampWarning}` : null,
								uniqueRepair.migrationOutput,
							].filter(Boolean)

							fs.writeFileSync(migrationLogPath, `${repairLogLines.join('\n')}\n`, 'utf8')
							appendStartupLog(`Inventory branch unique repair succeeded${uniqueRepair.stampWarning ? ` (stamp warning: ${uniqueRepair.stampWarning})` : ''}`)
							console.log('Inventory branch unique repair succeeded')
						} else {
							migrationFailureMessage = `${migrationDetails}\n\nAutomatic repair failed:\n${uniqueRepair.reason || 'not applicable'}`
							fs.writeFileSync(
								migrationLogPath,
								`[${new Date().toISOString()}] Migration failed\n${migrationFailureMessage}`,
								'utf8'
							)
							appendStartupLog(`Inventory branch unique repair failed: ${uniqueRepair.reason || 'unknown error'}`)
							console.error('Inventory branch unique repair failed (non-fatal):', migrationFailureMessage)
						}
					} else if (/\bP3009\b/.test(migrationDetails)) {
						// P3009: a previous migration is recorded as failed; Prisma blocks all new
						// migrations until it is resolved. Mark the failed migration as applied
						// (the schema changes were already partially or fully applied during the
						// failed run) then retry deploy.
						const failedNameMatch = migrationDetails.match(/The `(\d{14}_\S+)` migration started/)
						const failedMigrationName = failedNameMatch?.[1] ?? null
						appendStartupLog(`Migration reported P3009 (failed migration in history)${failedMigrationName ? `: ${failedMigrationName}` : ''}; attempting resolve`)

						if (!failedMigrationName) {
							migrationFailureMessage = `${migrationDetails}\n\nP3009 auto-resolve skipped: could not parse failed migration name from error.`
							fs.writeFileSync(migrationLogPath, `[${new Date().toISOString()}] Migration failed\n${migrationFailureMessage}`, 'utf8')
							appendStartupLog('P3009 auto-resolve skipped: could not parse failed migration name')
							console.error('P3009 auto-resolve skipped (non-fatal):', migrationFailureMessage)
						} else {
							try {
								runPrismaCommand(`migrate resolve --applied ${failedMigrationName}`)
								appendStartupLog(`P3009: marked ${failedMigrationName} as applied; retrying migrate deploy`)

								try {
									const retryOutput = runPrismaCommand('migrate deploy')
									fs.writeFileSync(migrationLogPath, `[${new Date().toISOString()}] P3009 resolved and migrations applied\n${retryOutput}`, 'utf8')
									appendStartupLog(`P3009 resolved: deploy succeeded after marking ${failedMigrationName} applied`)
									console.log('P3009 resolved: deploy succeeded')
								} catch (retryErr) {
									const retryStderr = retryErr?.stderr ? retryErr.stderr.toString() : ''
									const retryStdout = retryErr?.stdout ? retryErr.stdout.toString() : ''
									const retryDetails = `${retryErr?.message || 'Unknown retry error'}\n\nSTDOUT:\n${retryStdout}\n\nSTDERR:\n${retryStderr}`

									if (/\bP3018\b/.test(retryDetails) && /Migration name:\s*20260430000001_inventory_item_branch_scoped_unique/.test(retryDetails) && /inventory_items_userId_restaurantId_branchId_name_key already exists/.test(retryDetails)) {
										appendStartupLog('P3009 retry hit duplicate inventory branch unique index; attempting idempotent repair')
										const uniqueRepair = await attemptInventoryBranchScopedUniqueRepair({
											migrationsDir,
											userDataDir,
											runtimeDbPath: desktopRuntimeDbPath,
										})
										if (uniqueRepair.repaired) {
											fs.writeFileSync(migrationLogPath, `[${new Date().toISOString()}] P3009+P3018 resolved\n${uniqueRepair.migrationOutput || ''}`, 'utf8')
											appendStartupLog('P3009+P3018 resolved: inventory unique repair succeeded')
											console.log('P3009+P3018 resolved')
										} else {
											migrationFailureMessage = `${retryDetails}\n\nAutomatic P3018 repair after P3009 resolve failed:\n${uniqueRepair.reason || 'not applicable'}`
											fs.writeFileSync(migrationLogPath, `[${new Date().toISOString()}] Migration failed (P3009+P3018)\n${migrationFailureMessage}`, 'utf8')
											appendStartupLog(`P3009+P3018 repair failed: ${uniqueRepair.reason || 'unknown error'}`)
											console.error('P3009+P3018 repair failed (non-fatal):', migrationFailureMessage)
										}
									} else if (/\bP3018\b/.test(retryDetails) && /Migration name:\s*20260518000001_add_updatedAt_to_dish_sale_and_inventory_purchase/.test(retryDetails) && /duplicate column name: updatedAt/.test(retryDetails)) {
										// updatedAt columns already exist (schema drift); mark migration applied and finish.
										appendStartupLog('P3009 retry hit duplicate updatedAt column; marking migration applied')
										try {
											runPrismaCommand('migrate resolve --applied 20260518000001_add_updatedAt_to_dish_sale_and_inventory_purchase')
											const finalOutput = runPrismaCommand('migrate deploy')
											fs.writeFileSync(migrationLogPath, `[${new Date().toISOString()}] P3009+updatedAt drift resolved\n${finalOutput}`, 'utf8')
											appendStartupLog('P3009+updatedAt drift resolved: deploy succeeded')
											console.log('P3009+updatedAt drift resolved')
										} catch (finalErr) {
											const finalDetails = `${finalErr?.message || ''}\n${finalErr?.stderr?.toString() || ''}`
											migrationFailureMessage = `${retryDetails}\n\nupdatedAt drift resolve failed:\n${finalDetails}`
											fs.writeFileSync(migrationLogPath, `[${new Date().toISOString()}] Migration failed (P3009+updatedAt)\n${migrationFailureMessage}`, 'utf8')
											appendStartupLog(`P3009+updatedAt drift resolve failed: ${finalErr?.message || finalErr}`)
											console.error('P3009+updatedAt drift resolve failed (non-fatal):', migrationFailureMessage)
										}
									} else {
										migrationFailureMessage = `${retryDetails}\n\n(after P3009 resolve of ${failedMigrationName})`
										fs.writeFileSync(migrationLogPath, `[${new Date().toISOString()}] Migration failed after P3009 resolve\n${migrationFailureMessage}`, 'utf8')
										appendStartupLog(`Migration retry after P3009 resolve failed: ${retryErr?.message || retryErr}`)
										console.error('Migration retry after P3009 resolve failed (non-fatal):', migrationFailureMessage)
									}
								}
							} catch (resolveErr) {
								migrationFailureMessage = `${migrationDetails}\n\nP3009 auto-resolve failed: ${resolveErr?.message || resolveErr}`
								fs.writeFileSync(migrationLogPath, `[${new Date().toISOString()}] Migration failed\n${migrationFailureMessage}`, 'utf8')
								appendStartupLog(`P3009 auto-resolve failed: ${resolveErr?.message || resolveErr}`)
								console.error('P3009 auto-resolve failed (non-fatal):', migrationFailureMessage)
							}
						}
					} else if (/\bP3005\b/.test(migrationDetails)) {
						appendStartupLog('Migration reported P3005 (non-empty DB without migration history); checking for legacy desktop branch repair')
						const legacyRepair = await attemptLegacyDesktopBranchRepair({
							migrationsDir,
							runPrismaCommand,
							userDataDir,
							runtimeDbPath: desktopRuntimeDbPath,
						})

						if (legacyRepair.repaired) {
							const legacyRepairLogLines = [
								`[${new Date().toISOString()}] Legacy branch repair succeeded`,
								legacyRepair.backupPath ? `Backup: ${legacyRepair.backupPath}` : null,
								legacyRepair.duplicateGroups ? `Duplicate groups: ${formatDuplicateGroups(legacyRepair.duplicateGroups)}` : null,
								legacyRepair.baselineWarning ? `Baseline warning: ${legacyRepair.baselineWarning}` : null,
								legacyRepair.migrationOutput,
							].filter(Boolean)

							fs.writeFileSync(migrationLogPath, `${legacyRepairLogLines.join('\n')}\n`, 'utf8')
							appendStartupLog(`Legacy desktop branch repair succeeded${legacyRepair.baselineWarning ? ` (baseline warning: ${legacyRepair.baselineWarning})` : ''}`)
							console.log('Legacy desktop branch repair succeeded')
						} else {
							appendStartupLog(`Legacy desktop branch repair unavailable: ${String(legacyRepair.reason || 'not applicable').split('\n')[0]}`)
							appendStartupLog('Attempting db push fallback after legacy repair check')

							try {
								const dbPushOutput = runPrismaCommand('db push --skip-generate')

								fs.writeFileSync(
									migrationLogPath,
									`[${new Date().toISOString()}] Migration fallback succeeded (db push)\n${dbPushOutput}`,
									'utf8'
								)
								appendStartupLog('Database schema synchronized via db push fallback')
								console.log('Database schema synchronized via db push fallback')
							} catch (dbPushErr) {
								const dbPushStderr = dbPushErr?.stderr ? dbPushErr.stderr.toString() : ''
								const dbPushStdout = dbPushErr?.stdout ? dbPushErr.stdout.toString() : ''
								const dbPushDetails = `${dbPushErr?.message || 'Unknown db push error'}\n\nSTDOUT:\n${dbPushStdout}\n\nSTDERR:\n${dbPushStderr}`
								migrationFailureMessage = `${migrationDetails}\n\nLegacy branch repair:\n${legacyRepair.reason || 'not applicable'}\n\nFallback db push failed:\n${dbPushDetails}`

								fs.writeFileSync(
									migrationLogPath,
									`[${new Date().toISOString()}] Migration failed\n${migrationFailureMessage}`,
									'utf8'
								)
								appendStartupLog(`Migration fallback failed: ${dbPushErr?.message || dbPushErr}`)
								console.error('Migration fallback failed (non-fatal):', migrationFailureMessage)
							}
						}
					} else if (/recorded as applied in the database, but its file does not exist/i.test(migrationDetails)) {
						// Schema was squashed: old migration files were deleted but the local DB still
						// has their history entries. db push syncs the schema diff without caring
						// about migration history, so new columns are added without touching user data.
						appendStartupLog('Migration history has orphaned entries (squashed migrations); attempting db push to sync schema')
						try {
							const dbPushOutput = runPrismaCommand('db push --skip-generate --accept-data-loss')
							fs.writeFileSync(
								migrationLogPath,
								`[${new Date().toISOString()}] Schema sync succeeded via db push (squashed migrations)\n${dbPushOutput}`,
								'utf8'
							)
							appendStartupLog('Schema sync via db push succeeded (squashed migrations)')
							console.log('Schema sync via db push succeeded (squashed migrations)')
						} catch (dbPushErr) {
							const dbPushStderr = dbPushErr?.stderr ? dbPushErr.stderr.toString() : ''
							const dbPushStdout = dbPushErr?.stdout ? dbPushErr.stdout.toString() : ''
							migrationFailureMessage = `${migrationDetails}\n\ndb push fallback also failed:\n${dbPushErr?.message || ''}\n\nSTDOUT:\n${dbPushStdout}\n\nSTDERR:\n${dbPushStderr}`
							fs.writeFileSync(
								migrationLogPath,
								`[${new Date().toISOString()}] Migration failed\n${migrationFailureMessage}`,
								'utf8'
							)
							appendStartupLog(`Schema sync db push fallback failed: ${dbPushErr?.message || dbPushErr}`)
							console.error('Schema sync db push fallback failed (non-fatal):', migrationFailureMessage)
						}
					} else if (isDesktopSchemaCompatibilityRepairCandidate(migrationDetails)) {
						appendStartupLog('Migration reported non-executable SQLite drift; attempting targeted compatibility repair')
						const compatibilityRepair = await attemptDesktopSchemaCompatibilityRepair({
							userDataDir,
							runtimeDbPath: desktopRuntimeDbPath,
							nodePath: process.execPath,
							prismaCli: prismaJsEntrypoint,
							schemaPath,
							migrationEnv,
						})

						if (compatibilityRepair.repaired) {
							try {
								const retryOutput = runPrismaCommand(primaryDesktopSchemaCommand)
								const repairLogLines = [
									`[${new Date().toISOString()}] Compatibility repair succeeded`,
									compatibilityRepair.backupPath ? `Backup: ${compatibilityRepair.backupPath}` : null,
									compatibilityRepair.branchTableName ? `Branch table: ${compatibilityRepair.branchTableName}` : null,
									compatibilityRepair.actions?.length ? `Actions: ${compatibilityRepair.actions.join('; ')}` : null,
									`Retry command: ${primaryDesktopSchemaCommand}`,
									retryOutput,
								].filter(Boolean)

								fs.writeFileSync(migrationLogPath, `${repairLogLines.join('\n')}\n`, 'utf8')
								appendStartupLog('Compatibility repair succeeded; schema sync retry completed')
								console.log('Compatibility repair succeeded; schema sync retry completed')
							} catch (retryErr) {
								const retryStderr = retryErr?.stderr ? retryErr.stderr.toString() : ''
								const retryStdout = retryErr?.stdout ? retryErr.stdout.toString() : ''
								const retryDetails = `${retryErr?.message || 'Unknown db push retry error'}\n\nSTDOUT:\n${retryStdout}\n\nSTDERR:\n${retryStderr}`
								migrationFailureMessage = `${migrationDetails}\n\nCompatibility repair succeeded${compatibilityRepair.actions?.length ? ` (${compatibilityRepair.actions.join('; ')})` : ''}.\n\nRetry failed:\n${retryDetails}`
								fs.writeFileSync(
									migrationLogPath,
									`[${new Date().toISOString()}] Compatibility repair retry failed\n${migrationFailureMessage}`,
									'utf8'
								)
								appendStartupLog(`Compatibility repair retry failed: ${retryErr?.message || retryErr}`)
								console.error('Compatibility repair retry failed (non-fatal):', migrationFailureMessage)
							}
						} else {
							migrationFailureMessage = `${migrationDetails}\n\nCompatibility repair failed:\n${compatibilityRepair.reason || 'unknown error'}`
							fs.writeFileSync(
								migrationLogPath,
								`[${new Date().toISOString()}] Compatibility repair failed\n${migrationFailureMessage}`,
								'utf8'
							)
							appendStartupLog(`Compatibility repair failed: ${String(compatibilityRepair.reason || 'unknown error').split('\n')[0]}`)
							console.error('Compatibility repair failed (non-fatal):', migrationFailureMessage)
						}
					} else {
						migrationFailureMessage = migrationDetails
						fs.writeFileSync(
							migrationLogPath,
							`[${new Date().toISOString()}] Migration failed\n${migrationDetails}`,
							'utf8'
						)
						appendStartupLog(`Migration failed: ${migrationErr?.message || migrationErr}`)
						console.error('Migration failed (non-fatal):', migrationDetails)
					}
				}
			}
		} catch (migrationErr) {
			const migrationLogPath = path.join(app.getPath('userData'), 'migration.log')
			const stderr = migrationErr?.stderr ? migrationErr.stderr.toString() : ''
			const stdout = migrationErr?.stdout ? migrationErr.stdout.toString() : ''
			const details = `${migrationErr?.message || 'Unknown migration error'}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`
			migrationFailureMessage = details
			fs.writeFileSync(
				migrationLogPath,
				`[${new Date().toISOString()}] Migration failed\n${details}`,
				'utf8'
			)
			appendStartupLog(`Migration failed: ${migrationErr?.message || migrationErr}`)
			console.error('Migration failed (non-fatal):', details)
		}

		if (migrationFailureMessage) {
			appendStartupLog(
				migrationFailureShouldBlockStartup
					? 'Desktop schema sync failure is blocking startup before the server can recover.'
					: 'Desktop schema sync failed during startup, but the app will continue booting so runtime bootstrap can attempt repair.'
			)
		}

		if (migrationFailureMessage && migrationFailureShouldBlockStartup) {
			dialog.showErrorBox(
				'Database Update Failed',
				'Magnify could not upgrade the local desktop database for this app version. Please reinstall the latest build or check the migration log in your app data folder.'
			)
		}
	}

	// Watchdog: if the server hasn't started within 60 s, show a clear error
	const startupTimeout = setTimeout(() => {
		if (loadingWindow) {
			loadingWindow.close()
			loadingWindow = null
		}
		dialog.showErrorBox(
			'Startup Timeout',
			'The server took too long to start.\n\nPossible causes:\n• Another copy of the app is already running\n• Port 3001 is in use by another program\n• The database configuration is missing\n\nClose any other instances and try again.'
		)
		app.quit()
	}, 60000)

	// Resolve the standalone server — must be outside asar when packaged
	const standaloneDir = app.isPackaged
		? path.join(process.resourcesPath, 'app.asar.unpacked', '.next', 'standalone')
		: path.join(appDir, '.next', 'standalone')
	const standaloneServer = path.join(standaloneDir, 'server.js')
	appendStartupLog(`Resolved standaloneDir=${standaloneDir}`)
	appendStartupLog(`Resolved standaloneServer=${standaloneServer}`)

	if (!fs.existsSync(standaloneServer)) {
		clearTimeout(startupTimeout)
		if (loadingWindow) { loadingWindow.close(); loadingWindow = null }
		dialog.showErrorBox('Startup Error', `Standalone server not found at:\n${standaloneServer}\n\nPlease rebuild the application.`)
		app.quit()
		return
	}

	const { spawn } = require('child_process')
	const bundledNodePaths = getBundledNodePaths(appDir)
	const branchDeviceId = getOrCreateDeviceId()
	const internalBootstrapSecret = createInternalBootstrapSecret()
	const serverEnv = {
		...process.env,
		PORT: String(serverPort),
		HOSTNAME: '0.0.0.0',
		NODE_ENV: 'production',
		ELECTRON_RUN_AS_NODE: '1',
		MAGNIFY_DEVICE_ID: branchDeviceId,
		MAGNIFY_STARTUP_LOG_PATH: getStartupLogPath(),
		MAGNIFY_INTERNAL_BOOTSTRAP_SECRET: internalBootstrapSecret,
		MAGNIFY_USER_DATA_DIR: app.getPath('userData'),
		NODE_PATH: [...bundledNodePaths, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
	}
	appendStartupLog(`Bundled NODE_PATH=${serverEnv.NODE_PATH}`)
	appendStartupLog(`Branch device id=${branchDeviceId}`)

	const serverProcess = spawn(process.execPath, [standaloneServer], {
		cwd: standaloneDir,
		env: serverEnv,
		stdio: 'pipe'
	})
	appendStartupLog(`Spawned server process pid=${serverProcess.pid ?? 'unknown'}`)

	let serverStarted = false
	let serverDied = false
	let serverStdoutTail = ''
	let serverStderrTail = ''

	serverProcess.stdout.on('data', (data) => {
		const chunk = data.toString()
		serverStdoutTail = (serverStdoutTail + chunk).slice(-3000)
		console.log('[server]', chunk.trim())
		appendStartupLog(`[server] ${chunk.trim()}`)
	})
	serverProcess.stderr.on('data', (data) => {
		const chunk = data.toString()
		serverStderrTail = (serverStderrTail + chunk).slice(-3000)
		console.error('[server-err]', chunk.trim())
		appendStartupLog(`[server-err] ${chunk.trim()}`)
	})
	serverProcess.on('error', (err) => {
		appendStartupLog(`Server process error: ${err.message}`)
		if (!serverStarted) {
			serverDied = true
			clearTimeout(startupTimeout)
			if (loadingWindow) { loadingWindow.close(); loadingWindow = null }
			dialog.showErrorBox('Server Error', err.message)
			app.quit()
		}
	})
	serverProcess.on('exit', (code) => {
		appendStartupLog(`Server process exited with code ${code}`)
		if (!serverStarted) {
			serverDied = true
			clearTimeout(startupTimeout)
			if (loadingWindow) { loadingWindow.close(); loadingWindow = null }
			const stderr = serverStderrTail.trim()
			const stdout = serverStdoutTail.trim()
			const outputTail = stderr || stdout
			let hint = code === null
				? 'Server process was killed before it could start.'
				: `Server process exited with code ${code}.`

			if (outputTail) {
				hint += `\n\nServer output:\n${outputTail}`
			} else {
				hint += '\n\nPort 3001 may already be in use.'
			}
			dialog.showErrorBox('Server Error', hint)
			app.quit()
		}
	})

	app.on('before-quit', () => {
		clearDesktopUpdateSchedule()
		if (serverProcess && !serverProcess.killed) serverProcess.kill()
	})

	async function waitForServer() {
		if (serverDied) return
		http.get(`http://localhost:${serverPort}`, async () => {
			if (serverStarted) return
			serverStarted = true
			clearTimeout(startupTimeout)
			console.log(`Next.js server running — local: http://localhost:${serverPort} | LAN: http://${localIP}:${serverPort}`)
			appendStartupLog(`Next.js server ready on http://localhost:${serverPort} and http://${localIP}:${serverPort}`)

			try {
				const bootstrapResult = await runInternalBootstrap(serverPort, internalBootstrapSecret, branchDeviceId)
				appendStartupLog(`Internal bootstrap completed: ${JSON.stringify(bootstrapResult)}`)
				createWindow(localIP, serverPort)
			} catch (error) {
				const message = error?.message || String(error)
				appendStartupLog(`Internal bootstrap failed: ${message}`)

				if (shouldUseLocalDatabase && runDesktopPrismaCommand && isRecoverableBootstrapSchemaError(message)) {
					appendStartupLog('Internal bootstrap reported schema drift; attempting db push repair')

					try {
						const repairOutput = runDesktopPrismaCommand('db push --skip-generate')
						if (desktopMigrationLogPath) {
							fs.appendFileSync(
								desktopMigrationLogPath,
								`\n[${new Date().toISOString()}] Bootstrap schema repair succeeded\n${repairOutput}`,
								'utf8'
							)
						}
						appendStartupLog('Bootstrap schema repair succeeded; retrying internal bootstrap')

						try {
							const bootstrapRetryResult = await runInternalBootstrap(serverPort, internalBootstrapSecret, branchDeviceId)
							appendStartupLog(`Internal bootstrap completed after schema repair: ${JSON.stringify(bootstrapRetryResult)}`)
							createWindow(localIP, serverPort)
							return
						} catch (retryError) {
							const retryMessage = retryError?.message || String(retryError)
							appendStartupLog(`Internal bootstrap retry failed: ${retryMessage}`)
							createMaintenanceWindow(`${message}\n\nAutomatic schema repair succeeded, but bootstrap still failed:\n${retryMessage}`)
							return
						}
					} catch (repairError) {
						const repairStderr = repairError?.stderr ? repairError.stderr.toString() : ''
						const repairStdout = repairError?.stdout ? repairError.stdout.toString() : ''
						const repairDetails = `${repairError?.message || 'Unknown db push error'}\n\nSTDOUT:\n${repairStdout}\n\nSTDERR:\n${repairStderr}`
						if (desktopMigrationLogPath) {
							fs.appendFileSync(
								desktopMigrationLogPath,
								`\n[${new Date().toISOString()}] Bootstrap schema repair failed\n${repairDetails}`,
								'utf8'
							)
						}
						appendStartupLog(`Bootstrap schema repair failed: ${repairError?.message || repairError}`)
						createMaintenanceWindow(`${message}\n\nAutomatic schema repair failed:\n${repairDetails}`)
						return
					}
				}

				if (isNetworkConnectivityError(message)) {
					appendStartupLog('Bootstrap failed due to network connectivity; showing offline screen')
					offlineRetryCallback = async () => {
						if (mainWindow) { mainWindow.close(); mainWindow = null }
						createLoadingWindow()
						try {
							const retryResult = await runInternalBootstrap(serverPort, internalBootstrapSecret, branchDeviceId)
							appendStartupLog(`Offline retry bootstrap completed: ${JSON.stringify(retryResult)}`)
							if (loadingWindow) { loadingWindow.close(); loadingWindow = null }
							createWindow(localIP, serverPort)
						} catch (retryErr) {
							const retryMsg = retryErr?.message || String(retryErr)
							appendStartupLog(`Offline retry bootstrap failed: ${retryMsg}`)
							if (loadingWindow) { loadingWindow.close(); loadingWindow = null }
							if (isNetworkConnectivityError(retryMsg)) {
								createOfflineWindow()
							} else {
								createMaintenanceWindow(retryMsg)
							}
						}
					}
					createOfflineWindow()
					return
				}

				createMaintenanceWindow(message)
			}
		}).on('error', () => {
			if (!serverDied) setTimeout(waitForServer, 300)
		})
	}
	waitForServer()
})

app.on('window-all-closed', () => {
	app.quit()
})

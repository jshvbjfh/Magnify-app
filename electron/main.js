const { app, BrowserWindow, dialog, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const http = require('http')
const fs = require('fs')
const os = require('os')
const net = require('net')
const { createHash, randomBytes } = require('crypto')

function getStartupLogPath() {
	return path.join(app.getPath('userData'), 'startup.log')
}

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.allowPrerelease = false

const DESKTOP_UPDATE_INITIAL_DELAY_MS = 5000
const DESKTOP_UPDATE_RETRY_DELAYS_MS = [30000, 120000]
const DESKTOP_UPDATE_POLL_INTERVAL_MS = 10 * 60 * 1000
const DESKTOP_LEGACY_BASELINE_MIGRATION = '20260411120000_add_sync_infrastructure_tables'
const DESKTOP_BRANCH_FOUNDATION_MIGRATION = '20260421173000_add_restaurant_branch_foundation'

let desktopUpdateDeferredTimer = null
let desktopUpdatePollInterval = null
let desktopUpdateCheckInFlight = false
let desktopUpdateDownloaded = false

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
		const result = await autoUpdater.checkForUpdates()
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
	const autoUpdateEnabled = isDesktopAutoUpdateEnabled(autoUpdateFlag)
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
			const existingRows = await prisma.$queryRawUnsafe(
				`SELECT "id" FROM "_prisma_migrations" WHERE "migration_name" = '${escapeSqliteLiteral(migrationName)}' LIMIT 1`
			)
			if (existingRows.length > 0) continue

			const migrationFilePath = path.join(migrationsDir, migrationName, 'migration.sql')
			const checksum = calculateFileSha256(migrationFilePath)
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
			contextIsolation: true
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
		mainWindow.show()

		// Show the LAN address so the manager knows what to tell waiters
		if (localIP && localIP !== 'localhost') {
			dialog.showMessageBox(mainWindow, {
				type: 'info',
				title: 'Waiter Access URL',
				message: `Server is running on your network.\n\nWaiters can connect from any device on the same WiFi:\n\nhttp://${localIP}:${serverPort}\n\nShare this address with your waiters.`,
				buttons: ['Got it']
			})
		}

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

autoUpdater.on('checking-for-update', () => {
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

autoUpdater.on('update-available', (info) => {
	appendStartupLog(`Electron updater: update available ${info?.version || 'unknown'}`)
	pendingUpdateVersion = info?.version ? ' v' + info.version : ''
	showDownloadingBanner(pendingUpdateVersion)
})

autoUpdater.on('update-not-available', (info) => {
	appendStartupLog(`Electron updater: no update available (current ${app.getVersion()}, latest ${info?.version || app.getVersion()})`)
})

autoUpdater.on('download-progress', (progress) => {
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

autoUpdater.on('error', (error) => {
	appendStartupLog(`Electron updater error: ${error?.message || error}`)
})

// Prompt user to restart when an update has finished downloading
autoUpdater.on('update-downloaded', () => {
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
					autoUpdater.quitAndInstall()
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

	const configuredDatabaseUrl = String(process.env.DATABASE_URL || '')
	const hasCloudDatabaseUrl = configuredDatabaseUrl.startsWith('postgresql://') || configuredDatabaseUrl.startsWith('postgres://')
	const electronDataMode = normalizeElectronDataMode(process.env.ELECTRON_DATA_MODE || (app.isPackaged ? 'local-first' : 'cloud'))
	const shouldUseLocalDatabase = !hasCloudDatabaseUrl || (app.isPackaged && electronDataMode !== 'cloud')
	appendStartupLog(`Electron data mode=${electronDataMode}`)
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

	// Run local database migrations for packaged desktop installs.
	if (shouldUseLocalDatabase) {
		let migrationFailureMessage = null

		try {
			const { execSync } = require('child_process')
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

				const runPrismaCommand = (commandArgs) => execSync(
					`"${process.execPath}" "${prismaJsEntrypoint}" ${commandArgs} --schema "${schemaPath}"`,
					{
						cwd: userDataDir,
						env: migrationEnv,
						stdio: 'pipe',
						timeout: 20000,
					}
				).toString()
				runDesktopPrismaCommand = runPrismaCommand

				try {
					const migrationOutput = runPrismaCommand('migrate deploy')

					fs.writeFileSync(
						migrationLogPath,
						`[${new Date().toISOString()}] Migration succeeded\n${migrationOutput}`,
						'utf8'
					)
					appendStartupLog('Database migrations applied successfully')
					console.log('Database migrations applied successfully')
				} catch (migrationErr) {
					const migrationStderr = migrationErr?.stderr ? migrationErr.stderr.toString() : ''
					const migrationStdout = migrationErr?.stdout ? migrationErr.stdout.toString() : ''
					const migrationDetails = `${migrationErr?.message || 'Unknown migration error'}\n\nSTDOUT:\n${migrationStdout}\n\nSTDERR:\n${migrationStderr}`

					if (/\bP3005\b/.test(migrationDetails)) {
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
		MAGNIFY_INTERNAL_BOOTSTRAP_SECRET: internalBootstrapSecret,
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

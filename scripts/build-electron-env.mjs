import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'

const projectRoot = process.cwd()
const outputPath = resolve(projectRoot, 'electron', 'runtime.env')
const sourceFiles = [
	resolve(projectRoot, '.env.local'),
	resolve(projectRoot, '.env'),
]

const normalizedElectronDataMode = String(process.env.ELECTRON_DATA_MODE ?? '')
	.trim()
	.toLowerCase() === 'cloud'
	? 'cloud'
	: 'cloud'

const includeCloudDatabase = normalizedElectronDataMode === 'cloud'
	|| /^(1|true|yes)$/i.test(String(process.env.ELECTRON_INCLUDE_CLOUD_DATABASE ?? '').trim())

// SECURITY: NEXTAUTH_SECRET is generated per-device at runtime in main.js — never bundle it.
const allowedKeys = [
	'DATABASE_URL',
	'GEMINI_MODEL',
	'GEMINI_FALLBACK_MODEL',
	'TRIAL_DAYS',
	'NEXT_PUBLIC_APP_URL',
	'DESKTOP_AUTH_BRIDGE_URL',
	'DEV_ADMIN_KEY',
	'ELECTRON_DATA_MODE',
	'ELECTRON_AUTO_UPDATE',
	'OWNER_SYNC_TARGET_URL',
	'OWNER_SYNC_EMAIL',
	'OWNER_SYNC_SHARED_SECRET',
	'BLOB_READ_WRITE_TOKEN',
]

function parseEnvFile(filePath) {
	if (!existsSync(filePath)) return []
	const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
	return lines.flatMap((line) => {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) return []
		const eqIdx = trimmed.indexOf('=')
		if (eqIdx === -1) return []
		const key = trimmed.slice(0, eqIdx).trim()
		const value = trimmed.slice(eqIdx + 1).trim().replace(/^"|"$/g, '')
		return [[key, value]]
	})
}

const collected = new Map()

function isAllowedEnvKey(key) {
	return allowedKeys.includes(key)
}

for (const [key, rawValue] of Object.entries(process.env)) {
	if (!isAllowedEnvKey(key)) continue
	if (key === 'DATABASE_URL' && !includeCloudDatabase) continue
	if (typeof rawValue !== 'string' || !rawValue.length) continue
	collected.set(key, rawValue)
}

for (const filePath of sourceFiles) {
	for (const [key, value] of parseEnvFile(filePath)) {
		if (key === 'DATABASE_URL' && !includeCloudDatabase) continue
		if (isAllowedEnvKey(key) && !collected.has(key)) {
			collected.set(key, value)
		}
	}
}

if (!collected.has('ELECTRON_DATA_MODE')) {
	collected.set('ELECTRON_DATA_MODE', normalizedElectronDataMode)
}

if (!collected.has('ELECTRON_AUTO_UPDATE')) {
	collected.set('ELECTRON_AUTO_UPDATE', 'true')
}

const hasOwnerSyncTarget = Boolean(String(collected.get('OWNER_SYNC_TARGET_URL') ?? '').trim())
const hasOwnerSyncEmail = Boolean(String(collected.get('OWNER_SYNC_EMAIL') ?? '').trim())
// Auth credentials (shared secret / password) are never bundled — configure via Settings UI after install.
if (!hasOwnerSyncTarget || !hasOwnerSyncEmail) {
	console.warn('[build-electron-env] OWNER_SYNC_TARGET_URL or OWNER_SYNC_EMAIL is missing. Server-managed desktop sync will need manual configuration in Settings after install.')
}

const contents = Array.from(collected.entries())
	.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
	.join('\n')

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${contents}\n`, 'utf8')

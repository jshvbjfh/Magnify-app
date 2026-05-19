import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

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

function detectProvider(url) {
	if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
		return 'postgresql'
	}

	return 'sqlite'
}

function resolveProvider() {
	const buildTarget = String(process.env.BUILD_TARGET ?? '').trim().toLowerCase()
	const prismaForceProvider = String(process.env.PRISMA_FORCE_PROVIDER ?? '').trim().toLowerCase()
	const electronDataMode = String(process.env.ELECTRON_DATA_MODE ?? '').trim().toLowerCase()

	if (prismaForceProvider === 'postgresql' || prismaForceProvider === 'sqlite') {
		return prismaForceProvider
	}

	if (buildTarget === 'electron' && electronDataMode !== 'cloud') {
		return 'sqlite'
	}

	return detectProvider(String(process.env.DATABASE_URL ?? '').trim().toLowerCase())
}

function getLocalSqliteUrl() {
	return `file:${resolve(process.cwd(), 'prisma', 'dev.db').replace(/\\/g, '/')}`
}

const provider = resolveProvider()
const env = { ...process.env }

const prepareResult = spawnSync(process.execPath, [resolve(process.cwd(), 'scripts', 'prepare-prisma-schema.mjs')], {
	stdio: 'inherit',
	env,
})

if ((prepareResult.status ?? 1) !== 0) {
	process.exit(prepareResult.status ?? 1)
}

const schemaPath = provider === 'postgresql'
	? resolve(process.cwd(), 'prisma', 'postgres', 'schema.prisma')
	: resolve(process.cwd(), 'prisma', 'schema.prisma')
const prismaCliEntrypoint = resolve(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')

if (provider === 'sqlite') {
	env.DATABASE_URL = getLocalSqliteUrl()
}

const cliArgs = provider === 'postgresql'
	? ['migrate', 'deploy', '--schema', schemaPath]
	: ['db', 'push', '--schema', schemaPath, '--accept-data-loss', '--skip-generate']

// If the add_missing_tables_v2 migration is in a failed state (P3009), mark it
// rolled-back so migrate deploy can re-apply the now-idempotent SQL.
// We ignore errors here: if the migration doesn't exist or is already resolved, that's fine.
if (provider === 'postgresql') {
	spawnSync(process.execPath, [
		prismaCliEntrypoint,
		'migrate', 'resolve',
		'--rolled-back', '20260519100000_add_missing_tables_v2',
		'--schema', schemaPath,
	], { stdio: 'pipe', env })
}

console.log(`Running prisma ${provider === 'postgresql' ? 'migrate deploy' : 'db push'} for ${provider} using ${schemaPath}`)

const result = spawnSync(process.execPath, [prismaCliEntrypoint, ...cliArgs], {
	stdio: 'inherit',
	env,
})

if (result.error) {
	console.error(result.error)
}

process.exit(result.status ?? 1)
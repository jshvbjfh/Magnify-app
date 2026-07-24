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

// Neon sits behind a connection pooler, and a pooled connection can be returned
// to the pool without releasing Prisma's session-level advisory lock. The lock
// then outlives the process that took it, and every later `migrate deploy` fails
// with P1002 waiting on a lock nobody will ever release — so one deploy poisons
// the next, and because the build is `migrate deploy && build:web`, the whole
// site stops shipping. Deploys are effectively serialised per project anyway, so
// the lock buys us nothing here and costs us every subsequent deploy.
env.PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK = 'true'

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

// Migration 20260519100000_add_missing_tables_v2 kept failing due to unknown Neon DB
// state. Mark it as applied (skip it) so migrate deploy never tries to run it again.
// Migration 20260519200000_ensure_schema replaces it with defensive DDL.
// Error is silently ignored: if the migration is already applied or doesn't exist, that's fine.
if (provider === 'postgresql') {
	spawnSync(process.execPath, [
		prismaCliEntrypoint,
		'migrate', 'resolve',
		'--applied', '20260519100000_add_missing_tables_v2',
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
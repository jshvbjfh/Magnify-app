import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const prismaDir = resolve(process.cwd(), 'prisma')
const sourcePath = resolve(prismaDir, 'schema.prisma')
const outputPath = resolve(prismaDir, 'schema.generated.prisma')
const postgresDir = resolve(prismaDir, 'postgres')
const postgresSchemaPath = resolve(postgresDir, 'schema.prisma')

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

const source = readFileSync(sourcePath, 'utf8')
const databaseUrl = process.env.DATABASE_URL ?? ''
const buildTarget = String(process.env.BUILD_TARGET ?? '').trim().toLowerCase()
const prismaForceProvider = String(process.env.PRISMA_FORCE_PROVIDER ?? '').trim().toLowerCase()
const electronDataMode = String(process.env.ELECTRON_DATA_MODE ?? '').trim().toLowerCase()

function detectProvider(url) {
	if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
		return 'postgresql'
	}

	return 'sqlite'
}

function resolveProvider() {
	if (prismaForceProvider === 'postgresql' || prismaForceProvider === 'sqlite') {
		return prismaForceProvider
	}

	if (buildTarget === 'electron' && electronDataMode !== 'cloud') {
		return 'sqlite'
	}

	return detectProvider(databaseUrl)
}

function rewriteProvider(schemaSource, provider) {
	return schemaSource.replace(
	/(datasource\s+db\s*\{[\s\S]*?provider\s*=\s*")[^"]+("[\s\S]*?\})/m,
	`$1${provider}$2`
)
}

// Inject directUrl = env("DIRECT_URL") for PostgreSQL builds when DIRECT_URL is set.
// This tells Prisma to use the Neon connection pooler URL for queries (DATABASE_URL)
// and the direct (non-pooled) URL only for migrations (DIRECT_URL).
// Without this, every Vercel serverless invocation opens a raw Neon connection,
// exhausting the connection limit under load and causing P2024 timeouts.
function injectDirectUrl(schemaSource, provider) {
	if (provider !== 'postgresql') return schemaSource
	if (schemaSource.includes('directUrl')) return schemaSource
	if (!process.env.DIRECT_URL) return schemaSource
	return schemaSource.replace(
		/(url\s*=\s*env\("DATABASE_URL"\))/,
		'$1\n  directUrl = env("DIRECT_URL")'
	)
}

const provider = resolveProvider()
const rewritten = injectDirectUrl(rewriteProvider(source, provider), provider)
const postgresSchema = injectDirectUrl(rewriteProvider(source, 'postgresql'), 'postgresql')

writeFileSync(outputPath, rewritten)
mkdirSync(postgresDir, { recursive: true })
writeFileSync(postgresSchemaPath, postgresSchema)
console.log(`Prepared Prisma schema for ${provider} at ${outputPath}`)
console.log(`Prepared Prisma schema for postgresql at ${postgresSchemaPath}`)

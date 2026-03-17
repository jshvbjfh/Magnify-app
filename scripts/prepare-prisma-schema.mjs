import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const prismaDir = resolve(process.cwd(), 'prisma')
const sourcePath = resolve(prismaDir, 'schema.prisma')
const outputPath = resolve(prismaDir, 'schema.generated.prisma')

const source = readFileSync(sourcePath, 'utf8')
const databaseUrl = process.env.DATABASE_URL ?? ''

function detectProvider(url) {
	if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
		return 'postgresql'
	}

	return 'sqlite'
}

const provider = detectProvider(databaseUrl)
const rewritten = source.replace(
	/(datasource\s+db\s*\{[\s\S]*?provider\s*=\s*")[^"]+("[\s\S]*?\})/m,
	`$1${provider}$2`
)

writeFileSync(outputPath, rewritten)
console.log(`Prepared Prisma schema for ${provider} at ${outputPath}`)

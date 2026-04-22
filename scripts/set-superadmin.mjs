/**
 * Usage: node scripts/set-superadmin.mjs <email>
 *
 * Why this script avoids PrismaClient:
 * The main app generates a PostgreSQL-only Prisma client for deployment.
 * On local SQLite dev databases that client cannot initialize, so we use
 * `prisma db execute` directly against the DATABASE_URL instead.
 */
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'

const email = String(process.argv[2] ?? '').trim().toLowerCase()

if (!email) {
  console.error('Usage: node scripts/set-superadmin.mjs <email>')
  process.exit(1)
}

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(scriptPath), '..')

function readEnvFile(filePath) {
  const values = {}
  if (!fs.existsSync(filePath)) return values
  const content = fs.readFileSync(filePath, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue
    const key = line.slice(0, eqIndex).trim()
    const value = line.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, '')
    if (!(key in process.env)) process.env[key] = value
    values[key] = value
  }
  return values
}

const envFileValues = readEnvFile(path.join(projectRoot, '.env'))
const envLocalValues = readEnvFile(path.join(projectRoot, '.env.local'))

function resolveDatabaseUrl(rawUrl) {
  if (!rawUrl) return null
  if (!rawUrl.startsWith('file:')) return rawUrl

  const relativePath = rawUrl.slice('file:'.length)
  if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
    return rawUrl
  }

  const absolutePath = path.resolve(projectRoot, 'prisma', relativePath)
  return `file:${absolutePath.replace(/\\/g, '/')}`
}

const databaseUrl = resolveDatabaseUrl(
  process.env.SUPERADMIN_DATABASE_URL ||
  envFileValues.DATABASE_URL ||
  envLocalValues.DATABASE_URL ||
  process.env.DATABASE_URL
)

if (!databaseUrl) {
  console.error('DATABASE_URL is missing. Add it to .env/.env.local or pass SUPERADMIN_DATABASE_URL in the shell first.')
  process.exit(1)
}

const isPostgres = databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const sql = `UPDATE users SET isSuperAdmin = 1, isActive = 1 WHERE email = '${email.replace(/'/g, "''")}';`
const prismaCliPath = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js')

if (isPostgres) {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })

  try {
    const result = await prisma.user.updateMany({
      where: { email },
      data: { isSuperAdmin: true, isActive: true },
    })

    if (result.count === 0) {
      console.error(`No user found for ${email}.`)
      process.exit(1)
    }

    console.log(`Update executed successfully for ${email}.`)
    console.log('If that email already exists in the database, it is now active and super admin.')
  } catch (error) {
    console.error(error?.message || String(error))
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }

  process.exit(0)
}

if (!fs.existsSync(prismaCliPath)) {
  console.error('Prisma CLI not found. Run npm install first.')
  process.exit(1)
}

const result = spawnSync(process.execPath, [prismaCliPath, 'db', 'execute', '--url', databaseUrl, '--stdin'], {
  cwd: projectRoot,
  input: sql,
  encoding: 'utf8',
  env: process.env,
})

if (result.status !== 0) {
  console.error(result.stderr?.trim() || result.stdout?.trim() || result.error?.message || 'Failed to update user.')
  process.exit(result.status ?? 1)
}

console.log(`Update executed successfully for ${email}.`)
console.log('If that email already exists in the database, it is now active and super admin.')

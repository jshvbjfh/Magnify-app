import { PrismaClient } from '@prisma/client'
import fs from 'fs'

const sql = fs.readFileSync('prisma/migrations/neon_add_missing_columns.sql', 'utf8')
const prisma = new PrismaClient()

async function main() {
  // Strip comment lines, then split on semicolons
  const stripped = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n')
  const statements = stripped.split(';').map(s => s.trim()).filter(s => s.length > 0)
  for (const stmt of statements) {
    try {
      await prisma.$executeRawUnsafe(stmt)
      console.log('OK:', stmt.slice(0, 80))
    } catch (e: any) {
      console.error('ERROR on stmt:', stmt.slice(0, 80), '\n  ->', e.message)
    }
  }
  await prisma.$disconnect()
}

main()

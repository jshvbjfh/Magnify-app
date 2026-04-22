// Quick SQLite table check
import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = join(__dirname, '..', 'prisma', 'dev.db')
const db = new Database(dbPath, { readonly: true })

const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type='table' ORDER BY name").all()
console.log('Tables in dev.db:')
tables.forEach(t => {
  const count = db.prepare(`SELECT count(*) as c FROM "${t.name}"`).get()
  console.log(`  ${t.name}: ${count.c} rows`)
})

db.close()

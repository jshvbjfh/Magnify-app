// Read-only: verify Neon has the columns/tables the new code queries.
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const rows = await prisma.$queryRawUnsafe(`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE (table_name = 'inventory_items' AND column_name = 'type')
     OR (table_name = 'dishes' AND column_name IN ('preparedPortions', 'preparedPortionCost'))
     OR (table_name IN ('prep_ingredients', 'mep_list_items', 'prep_logs') AND column_name = 'id')
  ORDER BY table_name, column_name
`)
console.log(rows.map(r => `${r.table_name}.${r.column_name}`).join('\n'))
await prisma.$disconnect()

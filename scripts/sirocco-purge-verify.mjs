// READ-ONLY post-purge check: confirms no order/sale residue survives for
// SIROCCO Y SOL and that the remaining ledger is purchases-only and balanced.
import fs from 'fs'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const RID = 'cmssn2wif000210rcxlzs1jny'

const ob = await p.syncOutbox.groupBy({ by: ['entityType'], where: { restaurantId: RID }, _count: true })
console.log('remaining sync_outbox by entityType:', JSON.stringify(ob.map(x => [x.entityType, x._count])))

const je = await p.journalEntry.findMany({ where: { restaurantId: RID }, select: { description: true } })
const nonPurchase = je.filter(j => !(j.description || '').startsWith('Purchase:'))
console.log('remaining journal entries:', je.length, '| non-purchase among them:', nonPurchase.length)
if (nonPurchase.length) console.log(nonPurchase.slice(0, 10))

const lines = await p.journalLine.aggregate({
  where: { journalEntry: { restaurantId: RID } },
  _sum: { debit: true, credit: true },
})
console.log('ledger balance — debit:', lines._sum.debit, 'credit:', lines._sum.credit)

await p.$disconnect()

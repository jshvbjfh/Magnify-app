import { PrismaClient } from '@prisma/client';

const p = new PrismaClient({
  datasources: { db: { url: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require' } },
});

async function main() {
  const summaries = await p.dailySummary.findMany({ orderBy: { date: 'desc' }, take: 10 });
  console.log('=== Daily summaries:', summaries.length, '===');
  for (const s of summaries) {
    console.log(JSON.stringify({ date: s.date, rev: s.totalRevenue, exp: s.totalExpenses, pl: s.profitLoss, synced: s.synced, restaurantId: s.restaurantId }));
  }

  const syncedTxns = await p.transaction.findMany({ where: { synced: true }, take: 20, orderBy: { date: 'desc' }, include: { category: { select: { name: true, type: true } } } });
  console.log('\n=== Synced transactions:', syncedTxns.length, '===');
  for (const t of syncedTxns) {
    console.log(JSON.stringify({ desc: t.description, amount: t.amount, type: t.type, synced: t.synced, catType: t.category?.type, sourceKind: t.sourceKind }));
  }

  const allCount = await p.transaction.count();
  const syncedCount = await p.transaction.count({ where: { synced: true } });
  const unsyncedCount = await p.transaction.count({ where: { synced: false } });
  console.log(`\nTotal txns: ${allCount}, synced: ${syncedCount}, unsynced: ${unsyncedCount}`);

  // Check batches
  const batches = await p.restaurantSyncBatch.findMany({ orderBy: { appliedAt: 'desc' }, take: 5 });
  console.log('\n=== Sync batches:', batches.length, '===');
  for (const b of batches) {
    console.log(JSON.stringify({ batchId: b.batchId, status: b.status, txns: b.syncedTransactions, summaries: b.syncedSummaries, appliedAt: b.appliedAt }));
  }

  // Check sync states
  const states = await p.restaurantSyncState.findMany();
  console.log('\n=== Sync states:', states.length, '===');
  for (const s of states) {
    console.log(JSON.stringify({ restaurantId: s.restaurantId, lastSuccess: s.lastSuccessAt, lastError: s.lastErrorMessage, failures: s.consecutiveFailures }));
  }

  await p.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });

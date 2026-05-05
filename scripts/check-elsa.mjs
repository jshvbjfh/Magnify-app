import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const emails = ['elsapizzeria@gmail.com','elsapizzeriaowner@gmail.com'];
  const users = await p.user.findMany({
    where: { email: { in: emails } },
    select: { id:true, email:true, role:true, restaurantId:true, branchId:true, isActive:true }
  });
  console.log('=== USERS ===');
  console.log(JSON.stringify(users, null, 2));

  const rids = [...new Set(users.map(u => u.restaurantId).filter(Boolean))];
  const uids = users.map(u => u.id);

  const rests = await p.restaurant.findMany({
    where: { OR: [{ id: { in: rids } }, { ownerId: { in: uids } }] },
    select: { id:true, name:true, ownerId:true, syncRestaurantId:true }
  });
  console.log('=== RESTAURANTS ===');
  console.log(JSON.stringify(rests, null, 2));

  const allRids = [...new Set(rests.map(r => r.id))];
  if (!allRids.length) { console.log('No restaurants found'); return; }

  const branches = await p.restaurantBranch.findMany({
    where: { restaurantId: { in: allRids } },
    select: { id:true, restaurantId:true, name:true, isMain:true, isActive:true }
  });
  console.log('=== BRANCHES ===');
  console.log(JSON.stringify(branches, null, 2));

  // May 4 2026 — Kigali is UTC+2, so the local day is UTC 22:00 May 3 → 21:59 May 4
  const s = new Date('2026-05-03T22:00:00.000Z');
  const e = new Date('2026-05-04T21:59:59.999Z');

  const txGroups = await p.transaction.groupBy({
    by: ['restaurantId','branchId','type'],
    where: { restaurantId: { in: allRids }, date: { gte: s, lte: e }, synced: true },
    _sum: { amount: true },
    _count: { id: true }
  });
  console.log('=== CLOUD SYNCED TRANSACTIONS TODAY ===');
  console.log(JSON.stringify(txGroups, null, 2));

  const unsynced = await p.transaction.aggregate({
    where: { restaurantId: { in: allRids }, date: { gte: s, lte: e }, synced: false },
    _count: { id: true },
    _sum: { amount: true }
  });
  console.log('=== UNSYNCED TRANSACTIONS TODAY ===');
  console.log(JSON.stringify(unsynced, null, 2));

  const sums = await p.dailySummary.findMany({
    where: { restaurantId: { in: allRids }, date: { gte: s, lte: e } },
    select: { id:true, restaurantId:true, branchId:true, date:true, totalRevenue:true, totalExpenses:true, profitLoss:true, synced:true, lastUpdated:true }
  });
  console.log('=== DAILY SUMMARIES TODAY ===');
  console.log(JSON.stringify(sums, null, 2));

  const syncState = await p.restaurantSyncState.findMany({
    where: { restaurantId: { in: allRids } },
    select: { restaurantId:true, lastSuccessAt:true, lastErrorAt:true, lastErrorMessage:true, consecutiveFailures:true }
  });
  console.log('=== SYNC STATE ===');
  console.log(JSON.stringify(syncState, null, 2));

  const snapshot = await p.financialStatement.findFirst({
    where: { type: { startsWith: 'owner_sync_snapshot:' } },
    orderBy: { updatedAt: 'desc' },
    select: { type:true, updatedAt:true }
  });
  console.log('=== LATEST OWNER SNAPSHOT ===');
  console.log(JSON.stringify(snapshot, null, 2));
}

main()
  .catch(e => { console.error(e.message); process.exit(1); })
  .finally(() => p.$disconnect());

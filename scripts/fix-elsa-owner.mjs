/**
 * Global audit + fix for mis-linked owner-role viewer accounts.
 *
 * An owner-role user is "mis-linked" when:
 *   user.restaurantId = R1
 *   R1.ownerId = adminUserId
 *   adminUser.restaurantId = R2   (R2 ≠ R1)
 *
 * That means the admin moved to a new restaurant (R2) but the owner viewer
 * was never updated and is still reading from the old/orphan restaurant (R1).
 *
 * Fix: point the owner viewer at R2 + R2's main branch.
 *
 * Run with:
 *   $env:DATABASE_URL="<neon-url>"; node scripts/fix-elsa-owner.mjs
 *
 * Pass --dry-run to audit without writing anything.
 */

import { PrismaClient } from '@prisma/client';

const DRY_RUN = process.argv.includes('--dry-run');
const p = new PrismaClient();

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN (no writes) ===' : '=== LIVE FIX ===');

  // 1. All owner-role viewer accounts that have a restaurantId
  const ownerViewers = await p.user.findMany({
    where: { role: 'owner', restaurantId: { not: null } },
    select: { id: true, email: true, restaurantId: true, branchId: true }
  });
  console.log(`\nFound ${ownerViewers.length} owner-role viewer accounts to audit.\n`);

  let mislinkedCount = 0;
  let fixedCount = 0;
  let skippedCount = 0;

  for (const viewer of ownerViewers) {
    // 2. Get the restaurant the viewer is currently linked to
    const linkedRestaurant = await p.restaurant.findUnique({
      where: { id: viewer.restaurantId },
      select: { id: true, name: true, ownerId: true }
    });

    if (!linkedRestaurant) {
      console.log(`[ORPHAN]  ${viewer.email} → restaurantId ${viewer.restaurantId} does not exist`);
      skippedCount++;
      continue;
    }

    // 3. Get that restaurant's canonical admin (ownerId)
    const adminUser = await p.user.findUnique({
      where: { id: linkedRestaurant.ownerId },
      select: { id: true, email: true, role: true, restaurantId: true }
    });

    if (!adminUser) {
      console.log(`[ORPHAN]  ${viewer.email} → restaurant "${linkedRestaurant.name}" has no owner user`);
      skippedCount++;
      continue;
    }

    // 4. Find the canonical restaurant for that admin (by ownerId, not restaurantId)
    const canonicalRestaurant = await p.restaurant.findFirst({
      where: { ownerId: adminUser.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true }
    });

    if (!canonicalRestaurant) {
      console.log(`[SKIP]    ${viewer.email} → admin ${adminUser.email} owns no restaurant`);
      skippedCount++;
      continue;
    }

    if (viewer.restaurantId === canonicalRestaurant.id) {
      // Already correct
      continue;
    }

    // 5. Mis-link detected
    mislinkedCount++;
    console.log(`[MISLINK] ${viewer.email}`);
    console.log(`          Currently linked: "${linkedRestaurant.name}" (${linkedRestaurant.id})`);
    console.log(`          Should be linked: "${canonicalRestaurant.name}" (${canonicalRestaurant.id})`);
    console.log(`          Admin: ${adminUser.email}`);

    // 6. Find the main branch of the correct restaurant
    const mainBranch = await p.restaurantBranch.findFirst({
      where: { restaurantId: canonicalRestaurant.id, isActive: true },
      orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }],
      select: { id: true, name: true }
    });

    console.log(`          New branch: ${mainBranch ? `"${mainBranch.name}" (${mainBranch.id})` : 'none found'}`);

    if (!DRY_RUN) {
      await p.user.update({
        where: { id: viewer.id },
        data: {
          restaurantId: canonicalRestaurant.id,
          branchId: mainBranch?.id ?? null
        }
      });
      console.log(`          ✓ Fixed.`);
      fixedCount++;
    } else {
      console.log(`          (dry-run: no write)`);
    }
    console.log('');
  }

  console.log('=== SUMMARY ===');
  console.log(`Audited:    ${ownerViewers.length}`);
  console.log(`Mis-linked: ${mislinkedCount}`);
  console.log(`Fixed:      ${DRY_RUN ? '0 (dry-run)' : fixedCount}`);
  console.log(`Skipped:    ${skippedCount}`);
}

main()
  .catch(e => { console.error(e.message); process.exit(1); })
  .finally(() => p.$disconnect());

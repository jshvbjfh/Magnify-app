/**
 * Targeted fix for elsapizzeriaowner@gmail.com.
 *
 * This is a cross-ownership mis-link that the global audit script cannot
 * detect automatically. The viewer was provisioned against Restaurant A
 * (owned by a third user), but the intended admin is elsapizzeria@gmail.com
 * who owns Restaurant B. There is no stored "provisioned by" relation,
 * so this fix must be applied manually.
 */

import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const VIEWER_EMAIL = 'elsapizzeriaowner@gmail.com';
const ADMIN_EMAIL  = 'elsapizzeria@gmail.com';

async function main() {
  // Find the admin and their canonical restaurant
  const admin = await p.user.findUnique({
    where: { email: ADMIN_EMAIL },
    select: { id: true, email: true }
  });
  if (!admin) { console.error(`Admin ${ADMIN_EMAIL} not found`); process.exit(1); }

  const canonicalRestaurant = await p.restaurant.findFirst({
    where: { ownerId: admin.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true }
  });
  if (!canonicalRestaurant) { console.error(`No restaurant owned by ${ADMIN_EMAIL}`); process.exit(1); }

  const mainBranch = await p.restaurantBranch.findFirst({
    where: { restaurantId: canonicalRestaurant.id, isActive: true },
    orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }],
    select: { id: true, name: true }
  });

  // Find the viewer
  const viewer = await p.user.findUnique({
    where: { email: VIEWER_EMAIL },
    select: { id: true, email: true, restaurantId: true, branchId: true }
  });
  if (!viewer) { console.error(`Viewer ${VIEWER_EMAIL} not found`); process.exit(1); }

  console.log('BEFORE:', JSON.stringify(viewer, null, 2));
  console.log('Canonical restaurant:', JSON.stringify(canonicalRestaurant, null, 2));
  console.log('Main branch:', JSON.stringify(mainBranch, null, 2));

  if (viewer.restaurantId === canonicalRestaurant.id) {
    console.log('\nAlready correctly linked — nothing to do.');
    return;
  }

  const updated = await p.user.update({
    where: { id: viewer.id },
    data: {
      restaurantId: canonicalRestaurant.id,
      branchId: mainBranch?.id ?? null
    },
    select: { id: true, email: true, restaurantId: true, branchId: true }
  });
  console.log('\nAFTER:', JSON.stringify(updated, null, 2));
  console.log('\nDone.');
}

main()
  .catch(e => { console.error(e.message); process.exit(1); })
  .finally(() => p.$disconnect());

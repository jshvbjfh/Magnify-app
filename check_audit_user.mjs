import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const email = 'magnify.customer.audit.20260521.1421@gmail.com';
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      staffProfiles: {
        include: {
          restaurant: true,
          branches: {
            include: {
                branch: true
            }
          }
        }
      }
    }
  });

  if (!user) {
    console.log('User not found');
    return;
  }

  console.log('--- User Info ---');
  console.log('User ID:', user.id);
  
  const staff = user.staffProfiles[0];
  if (staff) {
    console.log('Staff ID:', staff.id);
    console.log('Restaurant ID:', staff.restaurantId);
    console.log('Restaurant Name:', staff.restaurant?.name);
    console.log('Branch IDs:', staff.branches.map(b => b.branchId).join(', '));

    const restaurant = staff.restaurant;
    console.log('--- Restaurant Settings ---');
    console.log('Settings:', JSON.stringify({
        inventoryTrackingMode: restaurant.inventoryTrackingMode,
        isInventoryTrackingEnabled: restaurant.isInventoryTrackingEnabled,
        qrGuestAccess: restaurant.qrGuestAccess,
        allowGuestOrders: restaurant.allowGuestOrders,
        settings: restaurant.settings
    }, null, 2));

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const branchIds = staff.branches.map(b => b.branchId);
    
    const purchases = await prisma.inventoryPurchase.findMany({
      where: {
        branchId: { in: branchIds },
        createdAt: { gte: today }
      },
      include: {
        item: true
      },
      orderBy: { createdAt: 'desc' }
    });

    console.log('--- Inventory Purchases ---');
    purchases.forEach(p => {
      console.log(JSON.stringify({
        id: p.id,
        ingredientId: p.inventoryItemId,
        batchId: p.batchId,
        purchaseQuantity: p.quantity,
        purchaseUnit: p.unit,
        unitCost: p.unitCost,
        totalCost: p.totalCost,
        purchasedAt: p.purchasedAt,
        createdAt: p.createdAt,
        ingredientName: p.item?.name,
        isBatchIdNull: p.batchId === null
      }, null, 2));
    });
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });

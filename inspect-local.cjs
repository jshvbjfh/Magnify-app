const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
async function run() {
  const r = await prisma.restaurant.findFirst({ where: { ownerEmail: "erickpizzeria@gmail.com" } });
  if (!r) { console.log(JSON.stringify({error: "no rest"})); return; }
  const b = await prisma.branch.findMany({ where: { restaurantId: r.id } });
  const d = await prisma.dish.count({ where: { restaurantId: r.id, isActive: true } });
  const t = await prisma.table.count({ where: { restaurantId: r.id } });
  let o = [], l = [], c = [];
  try {
    o = await prisma.$queryRawUnsafe("SELECT entityType, status, count(id) as cnt FROM sync_outbox WHERE restaurantId = '" + r.id + "' GROUP BY entityType, status");
    l = await prisma.$queryRawUnsafe("SELECT * FROM sync_outbox WHERE restaurantId = '" + r.id + "' ORDER BY createdAt DESC LIMIT 5");
    c = await prisma.$queryRawUnsafe("SELECT * FROM sync_cursors");
  } catch(e) { o = e.message; }
  console.log(JSON.stringify({r, b, d, t, o, l, c}));
}
run().then(() => prisma.$disconnect());

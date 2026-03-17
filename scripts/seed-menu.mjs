import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const EMAIL = 'gboy@gmail.com'

const menu = [
  // ── Mains ──────────────────────────────────────────────────────────────
  { name: 'Grilled Tilapia',         sellingPrice: 8500,  category: 'Mains' },
  { name: 'BBQ Chicken Platter',      sellingPrice: 9500,  category: 'Mains' },
  { name: 'Beef Brochettes',          sellingPrice: 10500, category: 'Mains' },
  { name: 'Grilled Pork Ribs',        sellingPrice: 12000, category: 'Mains' },
  { name: 'Lamb Chops',               sellingPrice: 14000, category: 'Mains' },
  { name: 'Fish & Chips',             sellingPrice: 7500,  category: 'Mains' },
  { name: 'Chicken Burger',           sellingPrice: 6500,  category: 'Mains' },
  { name: 'Beef Burger',              sellingPrice: 7000,  category: 'Mains' },
  { name: 'Vegetable Stir Fry',       sellingPrice: 5500,  category: 'Mains' },
  { name: 'Ugali & Nyama Choma',      sellingPrice: 9000,  category: 'Mains' },

  // ── Sides ───────────────────────────────────────────────────────────────
  { name: 'French Fries',             sellingPrice: 2500,  category: 'Sides' },
  { name: 'Sweet Potato Fries',       sellingPrice: 2800,  category: 'Sides' },
  { name: 'Coleslaw',                 sellingPrice: 1500,  category: 'Sides' },
  { name: 'Garden Salad',             sellingPrice: 2000,  category: 'Sides' },
  { name: 'Steamed Vegetables',       sellingPrice: 1800,  category: 'Sides' },
  { name: 'Fried Plantains',          sellingPrice: 2000,  category: 'Sides' },
  { name: 'Rice & Beans',             sellingPrice: 2500,  category: 'Sides' },
  { name: 'Garlic Bread',             sellingPrice: 1500,  category: 'Sides' },

  // ── Desserts ─────────────────────────────────────────────────────────────
  { name: 'Chocolate Lava Cake',      sellingPrice: 4500,  category: 'Desserts' },
  { name: 'Vanilla Ice Cream',        sellingPrice: 3000,  category: 'Desserts' },
  { name: 'Tiramisu',                 sellingPrice: 4000,  category: 'Desserts' },
  { name: 'Fruit Salad',              sellingPrice: 2500,  category: 'Desserts' },
  { name: 'Cheesecake',               sellingPrice: 4500,  category: 'Desserts' },
  { name: 'Crème Brûlée',             sellingPrice: 4000,  category: 'Desserts' },
  { name: 'Banana Split',             sellingPrice: 3500,  category: 'Desserts' },

  // ── Soft Drinks ──────────────────────────────────────────────────────────
  { name: 'Coca-Cola',                sellingPrice: 1000,  category: 'Soft Drinks' },
  { name: 'Fanta Orange',             sellingPrice: 1000,  category: 'Soft Drinks' },
  { name: 'Sprite',                   sellingPrice: 1000,  category: 'Soft Drinks' },
  { name: 'Pepsi',                    sellingPrice: 1000,  category: 'Soft Drinks' },
  { name: 'Tonic Water',              sellingPrice: 1200,  category: 'Soft Drinks' },
  { name: 'Ginger Ale',               sellingPrice: 1200,  category: 'Soft Drinks' },
  { name: 'Sparkling Water',          sellingPrice: 1500,  category: 'Soft Drinks' },
  { name: 'Still Water',              sellingPrice: 500,   category: 'Soft Drinks' },

  // ── Fruit Juices ────────────────────────────────────────────────────────
  { name: 'Fresh Mango Juice',        sellingPrice: 2500,  category: 'Fruit Juices' },
  { name: 'Fresh Orange Juice',       sellingPrice: 2500,  category: 'Fruit Juices' },
  { name: 'Passion Fruit Juice',      sellingPrice: 2500,  category: 'Fruit Juices' },
  { name: 'Pineapple Juice',          sellingPrice: 2500,  category: 'Fruit Juices' },
  { name: 'Watermelon Juice',         sellingPrice: 2500,  category: 'Fruit Juices' },
  { name: 'Avocado Smoothie',         sellingPrice: 3000,  category: 'Fruit Juices' },
  { name: 'Mixed Berry Smoothie',     sellingPrice: 3000,  category: 'Fruit Juices' },
  { name: 'Tamarind Juice',           sellingPrice: 2000,  category: 'Fruit Juices' },

  // ── Hot Drinks ───────────────────────────────────────────────────────────
  { name: 'Espresso',                 sellingPrice: 2000,  category: 'Hot Drinks' },
  { name: 'Cappuccino',               sellingPrice: 2500,  category: 'Hot Drinks' },
  { name: 'Latte',                    sellingPrice: 2500,  category: 'Hot Drinks' },
  { name: 'Americano',                sellingPrice: 2000,  category: 'Hot Drinks' },
  { name: 'Hot Chocolate',            sellingPrice: 2500,  category: 'Hot Drinks' },
  { name: 'English Breakfast Tea',    sellingPrice: 1500,  category: 'Hot Drinks' },
  { name: 'Green Tea',                sellingPrice: 1500,  category: 'Hot Drinks' },
  { name: 'Masala Chai',              sellingPrice: 2000,  category: 'Hot Drinks' },

  // ── Beer ─────────────────────────────────────────────────────────────────
  { name: 'Primus (500ml)',           sellingPrice: 2000,  category: 'Beer' },
  { name: 'Mutzig (500ml)',           sellingPrice: 2000,  category: 'Beer' },
  { name: 'Turbo King (500ml)',       sellingPrice: 2500,  category: 'Beer' },
  { name: 'Heineken (330ml)',         sellingPrice: 3000,  category: 'Beer' },
  { name: 'Amstel (330ml)',           sellingPrice: 3000,  category: 'Beer' },
  { name: 'Guinness (500ml)',         sellingPrice: 3500,  category: 'Beer' },
  { name: 'Corona (330ml)',           sellingPrice: 4000,  category: 'Beer' },

  // ── Wine & Beer ──────────────────────────────────────────────────────────
  { name: 'House Red Wine (glass)',   sellingPrice: 4000,  category: 'Wine & Beer' },
  { name: 'House White Wine (glass)', sellingPrice: 4000,  category: 'Wine & Beer' },
  { name: 'Rosé Wine (glass)',        sellingPrice: 4500,  category: 'Wine & Beer' },
  { name: 'Prosecco (glass)',         sellingPrice: 5000,  category: 'Wine & Beer' },
  { name: 'Red Wine Bottle',          sellingPrice: 25000, category: 'Wine & Beer' },
  { name: 'White Wine Bottle',        sellingPrice: 25000, category: 'Wine & Beer' },
  { name: 'Champagne Bottle',         sellingPrice: 60000, category: 'Wine & Beer' },

  // ── Spirits / Liquor ─────────────────────────────────────────────────────
  { name: 'Johnnie Walker Red (tot)', sellingPrice: 4000,  category: 'Spirits' },
  { name: 'Johnnie Walker Black (tot)',sellingPrice: 6000, category: 'Spirits' },
  { name: 'Jack Daniel\'s (tot)',     sellingPrice: 5000,  category: 'Spirits' },
  { name: 'Jameson Irish (tot)',      sellingPrice: 5000,  category: 'Spirits' },
  { name: 'Smirnoff Vodka (tot)',     sellingPrice: 3500,  category: 'Spirits' },
  { name: 'Bacardi Rum (tot)',        sellingPrice: 3500,  category: 'Spirits' },
  { name: 'Gordons Gin (tot)',        sellingPrice: 3500,  category: 'Spirits' },
  { name: 'Hennessy VS (tot)',        sellingPrice: 7000,  category: 'Spirits' },

  // ── Cocktails ────────────────────────────────────────────────────────────
  { name: 'Mojito',                   sellingPrice: 6000,  category: 'Cocktails' },
  { name: 'Piña Colada',              sellingPrice: 6500,  category: 'Cocktails' },
  { name: 'Margarita',                sellingPrice: 6000,  category: 'Cocktails' },
  { name: 'Cosmopolitan',             sellingPrice: 6500,  category: 'Cocktails' },
  { name: 'Long Island Iced Tea',     sellingPrice: 7500,  category: 'Cocktails' },
  { name: 'Daiquiri',                 sellingPrice: 6000,  category: 'Cocktails' },
  { name: 'Aperol Spritz',            sellingPrice: 7000,  category: 'Cocktails' },
  { name: 'Whiskey Sour',             sellingPrice: 6500,  category: 'Cocktails' },
  { name: 'Tequila Sunrise',          sellingPrice: 6500,  category: 'Cocktails' },
  { name: 'Sex on the Beach',         sellingPrice: 6500,  category: 'Cocktails' },
]

async function main() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } })
  if (!user) { console.error(`❌ User ${EMAIL} not found`); process.exit(1) }

  console.log(`✅ Found user: ${user.name} (${user.id})`)

  let created = 0, skipped = 0
  for (const item of menu) {
    try {
      await prisma.dish.create({ data: { userId: user.id, ...item } })
      created++
    } catch (e) {
      // @@unique([userId, name]) — skip duplicates
      skipped++
    }
  }

  console.log(`\n🍽️  Done! Created: ${created}  |  Skipped (already exist): ${skipped}`)
}

main().finally(() => prisma.$disconnect())

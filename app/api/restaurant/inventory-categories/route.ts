import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

// Stock categories are a lens over the inventory screen, nothing more. An
// item's category never touches costing, consumption or reporting, so every
// operation here is safe: the worst a mistake can do is file something under
// the wrong tab.

const MAX_NAME_LENGTH = 40

function cleanName(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

async function requireRestaurant() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId) return { error: NextResponse.json({ error: 'No restaurant found' }, { status: 400 }) }
  return { restaurantId, branchId }
}

// GET — the tab list, plus how many items sit under each.
export async function GET() {
  const auth = await requireRestaurant()
  if ('error' in auth) return auth.error
  const { restaurantId } = auth

  const [saved, used] = await Promise.all([
    prisma.inventoryCategory.findMany({
      where: { restaurantId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, sortOrder: true },
    }),
    // Categories typed onto items before this table existed still deserve a
    // tab, so the list is the union rather than just the saved rows.
    prisma.inventoryItem.groupBy({
      by: ['category'],
      where: { restaurantId, deletedAt: null, type: { not: 'prep' }, NOT: { category: null } },
      _count: { category: true },
    }),
  ])

  const counts = new Map(used.map((row) => [String(row.category), row._count.category]))
  const categories = saved.map((c) => ({ id: c.id, name: c.name, itemCount: counts.get(c.name) ?? 0 }))

  for (const [name, itemCount] of counts) {
    if (!name.trim()) continue
    if (categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) continue
    categories.push({ id: `implicit:${name}`, name, itemCount })
  }

  const uncategorised = await prisma.inventoryItem.count({
    where: { restaurantId, deletedAt: null, type: { not: 'prep' }, OR: [{ category: null }, { category: '' }] },
  })

  return NextResponse.json({ categories, uncategorised })
}

// POST — create a tab. It can be empty; items are added afterwards.
export async function POST(req: Request) {
  const auth = await requireRestaurant()
  if ('error' in auth) return auth.error
  const { restaurantId } = auth

  const body = await req.json().catch(() => ({}))
  const name = cleanName(body?.name)
  if (!name) return NextResponse.json({ error: 'Category name is required' }, { status: 400 })
  if (name.length > MAX_NAME_LENGTH) return NextResponse.json({ error: `Keep the name under ${MAX_NAME_LENGTH} characters` }, { status: 400 })
  if (name.toLowerCase() === 'all') return NextResponse.json({ error: '"All" is the built-in tab — pick another name' }, { status: 400 })

  const clash = await prisma.inventoryCategory.findFirst({
    where: { restaurantId, deletedAt: null, name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  })
  if (clash) return NextResponse.json({ error: 'That category already exists' }, { status: 409 })

  const last = await prisma.inventoryCategory.findFirst({
    where: { restaurantId, deletedAt: null },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  })

  const category = await prisma.inventoryCategory.create({
    data: { restaurantId, name, sortOrder: (last?.sortOrder ?? 0) + 1 },
  })

  return NextResponse.json({ category: { id: category.id, name: category.name, itemCount: 0 } }, { status: 201 })
}

// PATCH — rename a tab, or move items in and out of one.
export async function PATCH(req: Request) {
  const auth = await requireRestaurant()
  if ('error' in auth) return auth.error
  const { restaurantId, branchId } = auth

  const body = await req.json().catch(() => ({}))

  // Assigning items: category null clears them back to "All".
  if (Array.isArray(body?.itemIds)) {
    const itemIds: string[] = body.itemIds.filter((id: unknown) => typeof id === 'string' && id)
    if (itemIds.length === 0) return NextResponse.json({ error: 'No items given' }, { status: 400 })
    const target = body.category === null ? null : cleanName(body.category)
    if (target !== null && !target) return NextResponse.json({ error: 'Category name is required' }, { status: 400 })

    const updated = await prisma.inventoryItem.updateMany({
      where: { id: { in: itemIds }, restaurantId, deletedAt: null },
      data: { category: target },
    })

    // Keep other devices' screens in step — the category is on the item row.
    const items = await prisma.inventoryItem.findMany({ where: { id: { in: itemIds }, restaurantId } })
    for (const item of items) {
      await enqueueSyncChange(prisma, {
        restaurantId,
        branchId: item.branchId ?? branchId,
        entityType: 'inventoryItem',
        entityId: item.id,
        operation: 'upsert',
        payload: item,
      })
    }

    return NextResponse.json({ moved: updated.count, category: target })
  }

  // Renaming: the items carry the name, so they have to follow it.
  const from = cleanName(body?.from)
  const to = cleanName(body?.to)
  if (!from || !to) return NextResponse.json({ error: 'Both the old and new name are required' }, { status: 400 })
  if (to.length > MAX_NAME_LENGTH) return NextResponse.json({ error: `Keep the name under ${MAX_NAME_LENGTH} characters` }, { status: 400 })
  if (to.toLowerCase() === 'all') return NextResponse.json({ error: '"All" is the built-in tab — pick another name' }, { status: 400 })

  await prisma.$transaction(async (tx) => {
    const existing = await tx.inventoryCategory.findFirst({ where: { restaurantId, name: from, deletedAt: null } })
    if (existing) await tx.inventoryCategory.update({ where: { id: existing.id }, data: { name: to } })
    else await tx.inventoryCategory.create({ data: { restaurantId, name: to } })
    await tx.inventoryItem.updateMany({ where: { restaurantId, category: from }, data: { category: to } })
  })

  return NextResponse.json({ renamed: { from, to } })
}

// DELETE — remove a tab. Its items are never deleted, only uncategorised.
export async function DELETE(req: Request) {
  const auth = await requireRestaurant()
  if ('error' in auth) return auth.error
  const { restaurantId } = auth

  const { searchParams } = new URL(req.url)
  const name = cleanName(searchParams.get('name'))
  if (!name) return NextResponse.json({ error: 'Category name is required' }, { status: 400 })

  const released = await prisma.$transaction(async (tx) => {
    await tx.inventoryCategory.deleteMany({ where: { restaurantId, name } })
    const cleared = await tx.inventoryItem.updateMany({
      where: { restaurantId, category: name },
      data: { category: null },
    })
    return cleared.count
  })

  return NextResponse.json({ deleted: name, itemsReleased: released })
}

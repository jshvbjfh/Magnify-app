import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'
import { SignJWT } from 'jose'
import { ensureMainBranchForRestaurant } from '@/lib/restaurantAccess'

export const dynamic = 'force-dynamic'

const SECRET = new TextEncoder().encode(
  process.env.NEXTAUTH_SECRET ?? 'fallback-secret-change-me'
)

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0, must-revalidate',
}

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...(init?.headers ?? {}) },
  })
}

/** Resolve the branch for a staff member. Falls back to the restaurant's main branch. */
async function resolveStaffBranchId(staffId: string, restaurantId: string): Promise<string | null> {
  const assignment = await prisma.staffBranch.findFirst({
    where: { staffId, branch: { restaurantId, isActive: true } },
    include: { branch: { select: { id: true } } },
    orderBy: { createdAt: 'asc' },
  })
  if (assignment) return assignment.branch.id

  const mainBranch = await ensureMainBranchForRestaurant(restaurantId)
  return mainBranch?.id ?? null
}

/**
 * Resolve a restaurantId from an explicit id, joinCode, by staff username lookup,
 * or by auto-detecting the single restaurant in the database.
 */
async function resolveRestaurantId(
  rawRestaurantId: string | null,
  rawJoinCode: string | null,
  rawUsername: string | null = null,
): Promise<string | null> {
  if (rawRestaurantId) return rawRestaurantId

  if (rawJoinCode) {
    const restaurant = await prisma.restaurant.findUnique({
      where: { joinCode: rawJoinCode },
      select: { id: true },
    })
    return restaurant?.id ?? null
  }

  // Try to resolve via the staff member's restaurant — works for multi-tenant setups
  // where more than one restaurant exists and no explicit restaurantId was sent.
  // Only matches staff in non-deleted restaurants so old test data can't win.
  if (rawUsername) {
    const staff = await prisma.staff.findFirst({
      where: {
        isActive: true,
        deletedAt: null,
        restaurant: { deletedAt: null },
        OR: [{ username: rawUsername }, { name: rawUsername }],
      },
      select: { restaurantId: true },
      orderBy: { createdAt: 'desc' },
    })
    if (staff) return staff.restaurantId
  }

  // Fallback: auto-detect when there is exactly one restaurant (local-first single-restaurant).
  const restaurants = await prisma.restaurant.findMany({
    where: { deletedAt: null },
    select: { id: true },
    take: 2,
  })
  if (restaurants.length === 1) return restaurants[0].id

  return null
}

/**
 * POST /api/mobile/auth
 *
 * Accepts:
 *   { username, password }                        — Staff login (restaurant auto-detected in single-restaurant mode)
 *   { username, password, restaurantId|joinCode } — Staff login with explicit restaurant
 *   { pin, restaurantId }                         — PIN login on a shared device
 */
export async function POST(req: Request) {
  try {
    const body = await req.json()
    const rawUsername = typeof body.username === 'string' ? body.username.trim() : null
    const rawPassword = typeof body.password === 'string' ? body.password : null
    const rawPin = typeof body.pin === 'string' ? body.pin.trim() : null
    const rawRestaurantId = typeof body.restaurantId === 'string' ? body.restaurantId.trim() : null
    const rawJoinCode = typeof body.joinCode === 'string' ? body.joinCode.trim().toUpperCase() : null

    // ── PIN auth ──────────────────────────────────────────────────────────────
    if (rawPin && rawRestaurantId) {
      const allStaff = await prisma.staff.findMany({
        where: { restaurantId: rawRestaurantId, isActive: true, deletedAt: null, pin: { not: null } },
        select: { id: true, name: true, role: true, pin: true, restaurantId: true, username: true },
      })

      let matchedStaff: (typeof allStaff)[number] | null = null
      for (const s of allStaff) {
        if (s.pin && await bcrypt.compare(rawPin, s.pin)) {
          matchedStaff = s
          break
        }
      }

      if (!matchedStaff) {
        return jsonNoStore({ error: 'Incorrect PIN. Please try again.' }, { status: 401 })
      }

      const branchId = await resolveStaffBranchId(matchedStaff.id, matchedStaff.restaurantId)
      if (!branchId) {
        return jsonNoStore({ error: 'Your account is not linked to a station. Contact your manager.' }, { status: 403 })
      }

      const token = await new SignJWT({
        sub: matchedStaff.id,
        name: matchedStaff.name,
        role: matchedStaff.role,
        restaurantId: matchedStaff.restaurantId,
        branchId,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('30d')
        .sign(SECRET)

      return jsonNoStore({
        token,
        user: {
          id: matchedStaff.id,
          name: matchedStaff.name,
          email: matchedStaff.username ?? '',
          role: matchedStaff.role,
          restaurantId: matchedStaff.restaurantId,
          branchId,
        },
      })
    }

    // ── Username + password auth ───────────────────────────────────────────────
    if (rawUsername && rawPassword) {
      const restaurantId = await resolveRestaurantId(rawRestaurantId, rawJoinCode, rawUsername)

      if (!restaurantId) {
        return jsonNoStore({ error: 'Invalid email or password.' }, { status: 401 })
      }

      const matchedStaff = await prisma.staff.findFirst({
        where: {
          restaurantId,
          isActive: true,
          deletedAt: null,
          OR: [{ username: rawUsername }, { name: rawUsername }],
        },
        select: { id: true, name: true, role: true, password: true, restaurantId: true, username: true },
      })

      if (!matchedStaff || !matchedStaff.password) {
        return jsonNoStore({ error: 'Invalid email or password.' }, { status: 401 })
      }

      const valid = await bcrypt.compare(rawPassword, matchedStaff.password)
      if (!valid) {
        return jsonNoStore({ error: 'Invalid email or password.' }, { status: 401 })
      }

      const branchId = await resolveStaffBranchId(matchedStaff.id, matchedStaff.restaurantId)
      if (!branchId) {
        return jsonNoStore({ error: 'Your account is not linked to a station. Contact your manager.' }, { status: 403 })
      }

      const token = await new SignJWT({
        sub: matchedStaff.id,
        name: matchedStaff.name,
        role: matchedStaff.role,
        restaurantId: matchedStaff.restaurantId,
        branchId,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('30d')
        .sign(SECRET)

      return jsonNoStore({
        token,
        user: {
          id: matchedStaff.id,
          name: matchedStaff.name,
          email: matchedStaff.username ?? '',
          role: matchedStaff.role,
          restaurantId: matchedStaff.restaurantId,
          branchId,
        },
      })
    }

    return jsonNoStore(
      { error: 'Please enter your email and password.' },
      { status: 400 },
    )
  } catch (err) {
    console.error('[mobile/auth]', err)
    return jsonNoStore({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

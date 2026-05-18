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
 * POST /api/mobile/auth
 *
 * Accepts either:
 *   { username, password }            — Staff credentials (username scoped to restaurant via restaurantId or joinCode)
 *   { pin, restaurantId }             — Staff PIN on a shared device
 *   { username, password, joinCode }  — Staff credentials when restaurantId is unknown on device
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
      const staff = await prisma.staff.findFirst({
        where: {
          restaurantId: rawRestaurantId,
          isActive: true,
          deletedAt: null,
        },
        select: { id: true, name: true, role: true, pin: true, restaurantId: true },
      })

      // We fetch all active staff for this restaurant and compare PINs individually
      // (bcrypt compare is required — never compare plain PIN to hashed PIN with ===)
      const allStaff = await prisma.staff.findMany({
        where: { restaurantId: rawRestaurantId, isActive: true, deletedAt: null, pin: { not: null } },
        select: { id: true, name: true, role: true, pin: true, restaurantId: true },
      })

      let matchedStaff: (typeof allStaff)[number] | null = null
      for (const s of allStaff) {
        if (s.pin && await bcrypt.compare(rawPin, s.pin)) {
          matchedStaff = s
          break
        }
      }

      if (!matchedStaff) {
        return jsonNoStore({ error: 'Invalid PIN' }, { status: 401 })
      }

      const branchId = await resolveStaffBranchId(matchedStaff.id, matchedStaff.restaurantId)
      if (!branchId) {
        return jsonNoStore({ error: 'No branch configured for this restaurant.' }, { status: 403 })
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
        staff: {
          id: matchedStaff.id,
          name: matchedStaff.name,
          role: matchedStaff.role,
          restaurantId: matchedStaff.restaurantId,
          branchId,
        },
      })
    }

    // ── Username + password auth ───────────────────────────────────────────────
    if (rawUsername && rawPassword) {
      // Resolve restaurant — either by restaurantId or joinCode
      let restaurantId: string | null = rawRestaurantId
      if (!restaurantId && rawJoinCode) {
        const restaurant = await prisma.restaurant.findUnique({
          where: { joinCode: rawJoinCode },
          select: { id: true },
        })
        restaurantId = restaurant?.id ?? null
      }

      if (!restaurantId) {
        return jsonNoStore({ error: 'Restaurant not found. Provide a valid restaurantId or joinCode.' }, { status: 400 })
      }

      const matchedStaff = await prisma.staff.findFirst({
        where: { restaurantId, username: rawUsername, isActive: true, deletedAt: null },
        select: { id: true, name: true, role: true, password: true, restaurantId: true },
      })

      if (!matchedStaff || !matchedStaff.password) {
        return jsonNoStore({ error: 'Invalid username or password' }, { status: 401 })
      }

      const valid = await bcrypt.compare(rawPassword, matchedStaff.password)
      if (!valid) {
        return jsonNoStore({ error: 'Invalid username or password' }, { status: 401 })
      }

      const branchId = await resolveStaffBranchId(matchedStaff.id, matchedStaff.restaurantId)
      if (!branchId) {
        return jsonNoStore({ error: 'No branch configured for this restaurant.' }, { status: 403 })
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
        staff: {
          id: matchedStaff.id,
          name: matchedStaff.name,
          role: matchedStaff.role,
          restaurantId: matchedStaff.restaurantId,
          branchId,
        },
      })
    }

    return jsonNoStore(
      { error: 'Provide { username, password } for credential auth or { pin, restaurantId } for PIN auth.' },
      { status: 400 },
    )
  } catch (err) {
    console.error('[mobile/auth]', err)
    return jsonNoStore({ error: 'Server error' }, { status: 500 })
  }
}

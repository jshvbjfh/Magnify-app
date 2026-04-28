import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import bcrypt from 'bcryptjs'
import { SignJWT } from 'jose'
import { ensureMainBranchForRestaurant } from '@/lib/restaurantAccess'

const SECRET = new TextEncoder().encode(
  process.env.NEXTAUTH_SECRET ?? 'fallback-secret-change-me'
)

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json()

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { email: String(email).trim().toLowerCase() },
      select: {
        id: true, name: true, email: true, role: true,
        password: true, restaurantId: true, branchId: true,
        isActive: true,
      },
    })

    if (!user || !user.password) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    if (user.isActive === false) {
      return NextResponse.json({ error: 'Account is inactive' }, { status: 403 })
    }

    const valid = await bcrypt.compare(String(password), user.password)
    if (!valid) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    if (!['waiter', 'admin', 'kitchen'].includes(user.role)) {
      return NextResponse.json({ error: 'This app is for waiter accounts only' }, { status: 403 })
    }

    // Resolve branchId — the user.branchId column may be null for newly created
    // waiter accounts. Fall back to the restaurant's main branch so the JWT always
    // carries a valid branchId and /api/mobile/pull can return data.
    let resolvedBranchId = user.branchId
    if (!resolvedBranchId && user.restaurantId) {
      const mainBranch = await ensureMainBranchForRestaurant(user.restaurantId)
      if (mainBranch) {
        resolvedBranchId = mainBranch.id
        // Persist the resolved branch so future logins don't need to fall back
        await prisma.user.update({
          where: { id: user.id },
          data: { branchId: resolvedBranchId },
        })
      }
    }

    // Sign a JWT valid for 30 days
    const token = await new SignJWT({
      sub: user.id,
      email: user.email,
      role: user.role,
      restaurantId: user.restaurantId,
      branchId: resolvedBranchId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(SECRET)

    return NextResponse.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        restaurantId: user.restaurantId,
        branchId: resolvedBranchId,
      },
    })
  } catch (err) {
    console.error('[mobile/auth]', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

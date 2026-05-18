import { NextRequest, NextResponse } from 'next/server'
import { hash } from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { createRateLimiter, getRateLimitKey } from '@/lib/rateLimit'

// 5 password-reset attempts per IP per 15 minutes
const forgotLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 5 })

export async function POST(request: NextRequest) {
  const rlResult = forgotLimiter.check(getRateLimitKey(request, 'forgot'))
  if (!rlResult.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, {
      status: 429,
      headers: { 'Retry-After': String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)) },
    })
  }

  try {
    const body = await request.json()
    const { email, newPassword } = body

    if (!email || !newPassword) {
      return NextResponse.json({ error: 'Email and new password are required' }, { status: 400 })
    }

    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters long' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 })
    }

    const hashedPassword = await hash(newPassword, 12)
    await prisma.user.update({ where: { email }, data: { password: hashedPassword } })

    return NextResponse.json({ message: 'Password updated successfully' })
  } catch (error) {
    console.error('Forgot password error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

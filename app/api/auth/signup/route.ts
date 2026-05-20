import { NextRequest, NextResponse } from 'next/server'
import { hash } from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { isLocalFirstDesktopAuthBridgeEnabled, mirrorSignupToCloud, verifyCloudCredentials } from '@/lib/cloudAuthBridge'
import { prisma } from '@/lib/prisma'
import { ensureRestaurantForOwner } from '@/lib/restaurantAccess'
import { createRateLimiter, getRateLimitKey } from '@/lib/rateLimit'

const signupLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 5 })

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function getSignupErrorResponse(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return { status: 409, body: { error: 'User with this email already exists', code: error.code } }
    }
    if (error.code === 'P2022') {
      return {
        status: 500,
        body: {
          error: 'Signup failed because the database schema is out of date. Apply the latest Prisma schema and try again.',
          code: error.code,
        },
      }
    }
    if (error.code === 'P2021') {
      return {
        status: 500,
        body: {
          error: 'Signup failed because a required database table is missing. Apply the latest Prisma schema and try again.',
          code: error.code,
        },
      }
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return {
      status: 500,
      body: {
        error: 'Signup failed: server schema and database are not aligned. Apply the latest migrations and try again.',
        code: 'PRISMA_VALIDATION_ERROR',
      },
    }
  }

  const message = error instanceof Error && error.message ? error.message : 'Internal server error'
  return {
    status: 500,
    body: {
      error: process.env.NODE_ENV === 'production' ? 'Internal server error' : message,
      code: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null,
    },
  }
}

export async function POST(request: NextRequest) {
  const rlResult = signupLimiter.check(getRateLimitKey(request, 'signup'))
  if (!rlResult.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)) },
      },
    )
  }

  try {
    const body = await request.json()
    const name = String(body?.name ?? '').trim()
    const email = String(body?.email ?? '').trim().toLowerCase()
    const password = String(body?.password ?? '')
    const role = body?.role

    const missingFields: string[] = []
    if (!name) missingFields.push('name')
    if (!email) missingFields.push('email')
    if (!password) missingFields.push('password')

    if (missingFields.length > 0) {
      return NextResponse.json(
        { error: `Missing required fields: ${missingFields.join(', ')}` },
        { status: 400 },
      )
    }

    if (!EMAIL_REGEX.test(email)) {
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 })
    }

    if (name.length < 2 || name.length > 120) {
      return NextResponse.json(
        { error: 'Name must be between 2 and 120 characters long' },
        { status: 400 },
      )
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters long' },
        { status: 400 },
      )
    }

    if (password.length > 128) {
      return NextResponse.json({ error: 'Password is too long' }, { status: 400 })
    }

    let finalRole = role === 'owner' ? 'owner' : 'admin'

    if (isLocalFirstDesktopAuthBridgeEnabled()) {
      const cloudSignup = await mirrorSignupToCloud({ name, email, password, role })

      if (!cloudSignup.ok) {
        if (cloudSignup.status === 409) {
          const cloudAuth = await verifyCloudCredentials(email, password)
          if (!cloudAuth.ok) {
            return NextResponse.json(
              { error: cloudSignup.body?.error || 'User with this email already exists' },
              { status: 409 },
            )
          }
          finalRole =
            cloudAuth.user.role === 'owner' ? 'owner' : cloudAuth.user.role === 'admin' ? 'admin' : 'admin'
        } else {
          return NextResponse.json(
            cloudSignup.body ?? { error: 'Could not register this account with Magnify cloud.' },
            { status: cloudSignup.status || 503 },
          )
        }
      } else {
        const cloudRole = cloudSignup.body?.user?.role
        if (cloudRole === 'owner' || cloudRole === 'admin') finalRole = cloudRole
      }
    }

    const hashedPassword = await hash(password, 12)

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: finalRole,
        isActive: true,
      },
    })

    await ensureRestaurantForOwner(user.id)

    return NextResponse.json(
      {
        message: 'User created successfully',
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
      },
      { status: 201 },
    )
  } catch (error) {
    console.error('Signup error:', error)
    const response = getSignupErrorResponse(error)
    return NextResponse.json(response.body, { status: response.status })
  }
}

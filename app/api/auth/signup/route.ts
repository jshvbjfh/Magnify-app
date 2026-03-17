import { NextRequest, NextResponse } from 'next/server'
import { hash } from 'bcryptjs'
import { randomBytes } from 'crypto'
import { prisma } from '@/lib/prisma'

function generateRecoveryKey(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I
  const group = () => Array.from({ length: 4 }, () => chars[randomBytes(1)[0] % chars.length]).join('')
  return `JSSE-${group()}-${group()}-${group()}`
}

export async function POST(request: NextRequest) {
	try {
		const body = await request.json()
		const { name, email, password, trackingMode } = body

		// Validation - be specific about what's missing
		const missingFields = []
		if (!name) missingFields.push('name')
		if (!email) missingFields.push('email')
		if (!password) missingFields.push('password')
		
		if (missingFields.length > 0) {
			return NextResponse.json(
				{ error: `Missing required fields: ${missingFields.join(', ')}` },
				{ status: 400 }
			)
		}

		// Validate password length
		if (password.length < 8) {
			return NextResponse.json(
				{ error: 'Password must be at least 8 characters long' },
				{ status: 400 }
			)
		}

		// Restaurant app is restaurant-only
		const finalBusinessType = 'restaurant'

		// Check if user already exists
		const existingUser = await prisma.user.findUnique({
			where: { email }
		})

		if (existingUser) {
			return NextResponse.json(
				{ error: 'User with this email already exists' },
				{ status: 409 }
			)
		}

		// Hash password
		const hashedPassword = await hash(password, 12)

		// Generate recovery key
		const recoveryKey = generateRecoveryKey()
		const recoveryKeyHash = await hash(recoveryKey, 12)

		// Create user
		const user = await prisma.user.create({
			data: {
				name,
				email,
				password: hashedPassword,
				recoveryKeyHash,
				role: 'admin', // Default role
				businessType: finalBusinessType,
				trackingMode: trackingMode === 'dish_tracking' ? 'dish_tracking' : 'simple'
			}
		})

		return NextResponse.json(
			{
				message: 'User created successfully',
				recoveryKey,
				user: {
					id: user.id,
					name: user.name,
					email: user.email,
					role: user.role
				}
			},
			{ status: 201 }
		)
	} catch (error) {
		console.error('Signup error:', error)
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500 }
		)
	}
}

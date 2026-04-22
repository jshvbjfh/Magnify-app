import { NextRequest, NextResponse } from 'next/server'
import { hash } from 'bcryptjs'
import { randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'
import { isLocalFirstDesktopAuthBridgeEnabled, mirrorSignupToCloud, verifyCloudCredentials } from '@/lib/cloudAuthBridge'
import { prisma } from '@/lib/prisma'
import { ensureRestaurantForOwner } from '@/lib/restaurantAccess'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function logSignupError(error: unknown) {
	if (process.env.NODE_ENV === 'production') {
		console.error('Signup error:', error)
		return
	}

	console.error('Signup error:', error)
}

function getSignupErrorResponse(error: unknown) {
	if (error instanceof Prisma.PrismaClientKnownRequestError) {
		if (error.code === 'P2002') {
			return {
				status: 409,
				body: { error: 'User with this email already exists', code: error.code },
			}
		}

		if (error.code === 'P2022') {
			return {
				status: 500,
				body: {
					error: 'Signup failed because the database schema is out of date. Apply the latest Prisma schema on the deployed database and try again.',
					code: error.code,
				},
			}
		}

		if (error.code === 'P2021') {
			return {
				status: 500,
				body: {
					error: 'Signup failed because a required database table is missing. Apply the latest Prisma schema on the deployed database and try again.',
					code: error.code,
				},
			}
		}
	}

	if (error instanceof Prisma.PrismaClientValidationError) {
		return {
			status: 500,
			body: {
				error: 'Signup failed because the server schema and database schema are not aligned. Apply the latest Prisma schema on the deployed database and try again.',
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

function generateRecoveryKey(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I
  const group = () => Array.from({ length: 4 }, () => chars[randomBytes(1)[0] % chars.length]).join('')
  return `JSSE-${group()}-${group()}-${group()}`
}

export async function POST(request: NextRequest) {
	try {
		const body = await request.json()
		const name = String(body?.name ?? '').trim()
		const email = String(body?.email ?? '').trim().toLowerCase()
		const password = String(body?.password ?? '')
		const trackingMode = body?.trackingMode
		const qrOrderingMode = body?.qrOrderingMode
		const role = body?.role

		// Validation - be specific about what's missing
		const missingFields: string[] = []
		if (!name) missingFields.push('name')
		if (!email) missingFields.push('email')
		if (!password) missingFields.push('password')
		
		if (missingFields.length > 0) {
			return NextResponse.json(
				{ error: `Missing required fields: ${missingFields.join(', ')}` },
				{ status: 400 }
			)
		}

		if (!EMAIL_REGEX.test(email)) {
			return NextResponse.json(
				{ error: 'Please enter a valid email address' },
				{ status: 400 }
			)
		}

		if (name.length < 2 || name.length > 120) {
			return NextResponse.json(
				{ error: 'Name must be between 2 and 120 characters long' },
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

		if (password.length > 128) {
			return NextResponse.json(
				{ error: 'Password is too long' },
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

		let recoveryKey: string | null = null
		let finalRole = role === 'owner' ? 'owner' : 'admin'
		const shouldMirrorSignupToCloud = isLocalFirstDesktopAuthBridgeEnabled()

		if (shouldMirrorSignupToCloud) {
			const cloudSignup = await mirrorSignupToCloud({
				name,
				email,
				password,
				trackingMode,
				qrOrderingMode,
				role,
			})

			if (!cloudSignup.ok) {
				if (cloudSignup.status === 409) {
					const cloudAuth = await verifyCloudCredentials(email, password)
					if (!cloudAuth.ok) {
						return NextResponse.json(
							{ error: cloudSignup.body?.error || 'User with this email already exists' },
							{ status: 409 }
						)
					}

					finalRole = cloudAuth.user.role === 'owner' ? 'owner' : cloudAuth.user.role === 'admin' ? 'admin' : 'admin'
				} else {
					return NextResponse.json(
						cloudSignup.body ?? { error: 'Could not register this account with Magnify cloud.' },
						{ status: cloudSignup.status || 503 }
					)
				}
			} else {
				recoveryKey = typeof cloudSignup.body?.recoveryKey === 'string' ? cloudSignup.body.recoveryKey : null
				finalRole = cloudSignup.body?.user?.role === 'owner' ? 'owner' : cloudSignup.body?.user?.role === 'admin' ? 'admin' : finalRole
			}
		}

		// Hash password
		const hashedPassword = await hash(password, 12)

		// Generate recovery key
		recoveryKey = recoveryKey || generateRecoveryKey()
		const recoveryKeyHash = await hash(recoveryKey, 12)

		// Create user
		const user = await prisma.user.create({
			data: {
				name,
				email,
				password: hashedPassword,
				recoveryKeyHash,
				role: finalRole,
				businessType: finalBusinessType,
				trackingMode: trackingMode === 'dish_tracking' ? 'dish_tracking' : 'simple',
				isActive: false,
			}
		})

		if (finalRole === 'admin') {
			const restaurant = await ensureRestaurantForOwner(user.id)
			if (restaurant && (qrOrderingMode === 'order' || qrOrderingMode === 'view_only' || qrOrderingMode === 'disabled')) {
				await prisma.restaurant.update({
					where: { id: restaurant.id },
					data: { qrOrderingMode }
				})
			}
		}

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
		logSignupError(error)
		const response = getSignupErrorResponse(error)
		return NextResponse.json(response.body, { status: response.status })
	}
}

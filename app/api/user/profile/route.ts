import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { authOptions } from '@/lib/auth'
import { databaseUnavailableJson, isPrismaDatabaseUnavailableError, logDatabaseUnavailable } from '@/lib/apiDatabase'
import { getEffectiveFifoEnabled, getStoredFifoEnabled } from '@/lib/fifoFeature'
import { getRestaurantFifoAvailability, getRestaurantFifoRuntimeAvailability } from '@/lib/fifoRollout'
import { prisma } from '@/lib/prisma'
import { ensureRestaurantForOwner, getRestaurantContextForUser } from '@/lib/restaurantAccess'

const profileUserSelect = {
	id: true,
	name: true,
	email: true,
	businessType: true,
	logoUrl: true,
	role: true,
	trackingMode: true,
	fifoEnabled: true,
} as const

async function getRestaurantForProfile(userId: string, role: string) {
	const context = await getRestaurantContextForUser(userId)
	if (context?.restaurant) return context.restaurant

	if (role === 'admin' || role === 'owner') {
		return ensureRestaurantForOwner(userId)
	}

	return null
}

function buildProfilePayload(
	user: {
		id: string
		name: string | null
		email: string
		businessType: string | null
		logoUrl: string | null
		role: string
		trackingMode: string
		fifoEnabled: boolean
	},
	restaurant: {
		id?: string | null
		syncRestaurantId?: string | null
		fifoEnabled?: boolean | null
		fifoConfiguredAt?: Date | null
		fifoCutoverAt?: Date | null
	} | null
) {
	const storedFifoEnabled = getStoredFifoEnabled(restaurant?.fifoEnabled, user.fifoEnabled)
	const fifoAvailable = getRestaurantFifoAvailability(restaurant)

	return {
		...user,
		fifoEnabled: getEffectiveFifoEnabled(storedFifoEnabled, getRestaurantFifoRuntimeAvailability(restaurant)),
		fifoAvailable,
		fifoConfiguredAt: restaurant?.fifoConfiguredAt ?? null,
		fifoCutoverAt: restaurant?.fifoCutoverAt ?? null,
		fifoScope: restaurant ? 'restaurant' : 'user',
	}
}

// GET: Get user profile
export async function GET() {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const user = await prisma.user.findUnique({
			where: { id: session.user.id },
			select: profileUserSelect,
		})

		if (!user) {
			return NextResponse.json({ error: 'User not found' }, { status: 404 })
		}

		const restaurant = await getRestaurantForProfile(session.user.id, user.role)

		return NextResponse.json(buildProfilePayload(user, restaurant))
	} catch (error) {
		if (isPrismaDatabaseUnavailableError(error)) {
			logDatabaseUnavailable('api/user/profile GET', error)
			return databaseUnavailableJson({
				message: 'User profile is temporarily unavailable while the database connection is down.',
			})
		}

		console.error('Error fetching user profile:', error)
		return NextResponse.json(
			{ error: 'Failed to fetch user profile' },
			{ status: 500 }
		)
	}
}

// PATCH: Update user profile
export async function PATCH(request: Request) {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const body = await request.json()
		const { businessType, logoUrl, trackingMode } = body

		console.log('Updating profile for user:', session.user.id)
		console.log('Business Type:', businessType)
		console.log('Logo URL length:', logoUrl?.length || 0)

		// Validate businessType
		const validBusinessTypes = ['products', 'services', 'both']
		if (businessType && !validBusinessTypes.includes(businessType)) {
			return NextResponse.json(
				{ error: 'Invalid business type. Must be products, services, or both' },
				{ status: 400 }
			)
		}

		const currentUser = await prisma.user.findUnique({
			where: { id: session.user.id },
			select: profileUserSelect,
		})

		if (!currentUser) {
			return NextResponse.json({ error: 'User not found' }, { status: 404 })
		}

		const currentRestaurant = await getRestaurantForProfile(session.user.id, currentUser.role)

		// Build update data
		const updateData: any = {}
		if (businessType !== undefined) updateData.businessType = businessType
		if (logoUrl !== undefined) updateData.logoUrl = logoUrl
		if (trackingMode === 'simple' || trackingMode === 'dish_tracking') updateData.trackingMode = trackingMode

		console.log('Update data keys:', Object.keys(updateData))

		const updatedUser = Object.keys(updateData).length > 0
			? await prisma.user.update({
				where: { id: session.user.id },
				data: updateData,
				select: profileUserSelect,
			})
			: await prisma.user.findUniqueOrThrow({
				where: { id: session.user.id },
				select: profileUserSelect,
			})

		console.log('Profile updated successfully')
		return NextResponse.json(buildProfilePayload(updatedUser, currentRestaurant))
	} catch (error) {
		if (isPrismaDatabaseUnavailableError(error)) {
			logDatabaseUnavailable('api/user/profile PATCH', error)
			return databaseUnavailableJson({
				message: 'User profile could not be updated because the database connection is down.',
			})
		}

		console.error('Error updating user profile:', error)
		return NextResponse.json(
			{ error: 'Failed to update user profile: ' + (error instanceof Error ? error.message : String(error)) },
			{ status: 500 }
		)
	}
}

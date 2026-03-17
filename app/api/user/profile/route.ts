import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// GET: Get user profile
export async function GET() {
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const user = await prisma.user.findUnique({
			where: { id: session.user.id },
			select: {
				id: true,
				name: true,
				email: true,
				businessType: true,
				logoUrl: true,
				role: true,
				trackingMode: true,
				fifoEnabled: true
			} as any
		})

		if (!user) {
			return NextResponse.json({ error: 'User not found' }, { status: 404 })
		}

		return NextResponse.json(user)
	} catch (error) {
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
		const { businessType, logoUrl, trackingMode, fifoEnabled } = body

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

		// Build update data
		const updateData: any = {}
		if (businessType !== undefined) updateData.businessType = businessType
		if (logoUrl !== undefined) updateData.logoUrl = logoUrl
		if (trackingMode === 'simple' || trackingMode === 'dish_tracking') updateData.trackingMode = trackingMode
		if (typeof fifoEnabled === 'boolean') updateData.fifoEnabled = fifoEnabled

		console.log('Update data keys:', Object.keys(updateData))

		// Update user
		const updatedUser = await prisma.user.update({
			where: { id: session.user.id },
			data: updateData,
			select: {
				id: true,
				name: true,
				email: true,
				businessType: true,
				logoUrl: true,
				role: true,
				trackingMode: true,
				fifoEnabled: true
			} as any
		})

		console.log('Profile updated successfully')
		return NextResponse.json(updatedUser)
	} catch (error) {
		console.error('Error updating user profile:', error)
		return NextResponse.json(
			{ error: 'Failed to update user profile: ' + (error instanceof Error ? error.message : String(error)) },
			{ status: 500 }
		)
	}
}

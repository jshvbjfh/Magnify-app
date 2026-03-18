import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { findOwnedRestaurant } from '@/lib/restaurantAccess'

const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '30')

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = session.user as any
  // Find the restaurant owned by this user
  const restaurant = await findOwnedRestaurant(user.id)

  // If no restaurant yet (hasn't gone through setup), treat as fresh trial
  if (!restaurant) {
    return NextResponse.json({ status: 'trial', daysLeft: TRIAL_DAYS, trialDays: TRIAL_DAYS })
  }

  if (!restaurant.licenseActive) {
    return NextResponse.json({ status: 'suspended', daysLeft: 0, trialDays: TRIAL_DAYS })
  }

  const now = Date.now()

  if (restaurant.licenseExpiry && restaurant.licenseExpiry.getTime() > now) {
    const daysLeft = Math.ceil((restaurant.licenseExpiry.getTime() - now) / 86400000)
    return NextResponse.json({ status: 'active', daysLeft, licenseExpiry: restaurant.licenseExpiry, trialDays: TRIAL_DAYS })
  }

  const trialEnd = restaurant.trialStartAt.getTime() + TRIAL_DAYS * 86400000
  if (now <= trialEnd) {
    const daysLeft = Math.ceil((trialEnd - now) / 86400000)
    return NextResponse.json({ status: 'trial', daysLeft, trialDays: TRIAL_DAYS })
  }

  // Expired
  return NextResponse.json({ status: 'expired', daysLeft: 0, trialDays: TRIAL_DAYS })
}

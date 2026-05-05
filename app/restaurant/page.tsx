import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import RestaurantShell from '@/components/RestaurantShell'
import RestaurantBootstrapGate from '@/components/restaurant/RestaurantBootstrapGate'
import { getRestaurantBootstrapStatus, isRestaurantBootstrapRole } from '@/lib/restaurantBootstrap'

export const metadata = {
  title: 'Magnify - Restaurant',
  description: 'Restaurant management system',
}

export default async function RestaurantPage() {
  const session = await getServerSession(authOptions)
  if (!session) {
    redirect('/login')
  }

  const role = (session.user as any)?.role
  if (session.user.id && isRestaurantBootstrapRole(role)) {
    const bootstrapStatus = await getRestaurantBootstrapStatus(session.user.id)
    if (bootstrapStatus.required) {
      return <RestaurantBootstrapGate initialMessage={bootstrapStatus.message} />
    }
  }

  return <RestaurantShell />
}

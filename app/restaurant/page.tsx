import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import RestaurantShell from '@/components/RestaurantShell'

export const metadata = {
  title: 'Magnify - Restaurant',
  description: 'Restaurant management system',
}

export default async function RestaurantPage() {
  const session = await getServerSession(authOptions)
  if (!session) {
    redirect('/login')
  }

  return <RestaurantShell />
}

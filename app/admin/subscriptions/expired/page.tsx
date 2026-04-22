import { getServerSession } from 'next-auth'
import { redirect } from 'next/navigation'
import { authOptions } from '@/lib/auth'
import ExpiredSubscriptionsDashboard from '@/components/admin/ExpiredSubscriptionsDashboard'

export default async function ExpiredSubscriptionsPage() {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) redirect('/restaurant')

  return <ExpiredSubscriptionsDashboard />
}
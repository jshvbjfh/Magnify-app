import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import OwnerShell from '@/components/restaurant/OwnerShell'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata = {
  title: 'Magnify - Owner App',
  description: 'Owner workspace',
}

export default async function OwnerAppPage() {
  const session = await getServerSession(authOptions)
  if (!session) {
    redirect('/login')
  }

  const role = (session.user as any)?.role
  if (role !== 'owner') {
    redirect('/restaurant')
  }

  return <OwnerShell />
}

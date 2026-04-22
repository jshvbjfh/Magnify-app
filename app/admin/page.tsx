import { getServerSession } from 'next-auth'
import { redirect } from 'next/navigation'
import { authOptions } from '@/lib/auth'
import AdminDashboard from '@/components/AdminDashboard'

export default async function AdminPage() {
  const session = await getServerSession(authOptions)
  if (!(session?.user as any)?.isSuperAdmin) redirect('/restaurant')
  return <AdminDashboard />
}

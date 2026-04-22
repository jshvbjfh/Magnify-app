'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import AdminNav from '@/components/admin/AdminNav'

type ExpiredSubscriptionRow = {
  userId: string
  restaurantId: string
  restaurantName: string
  plan: string | null
  subscriptionActivatedAt: string | null
  subscriptionExpiry: string
  daysOverdue: number
  isActive: boolean
}

type ExpiringSoonRow = {
  userId: string
  restaurantId: string
  restaurantName: string
  plan: string | null
  subscriptionActivatedAt: string | null
  subscriptionExpiry: string
  daysRemaining: number
  isActive: boolean
}

type Payload = {
  expired: ExpiredSubscriptionRow[]
  expiringSoon: ExpiringSoonRow[]
}

function formatDate(value: string | null) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function planLabel(plan: string | null) {
  return plan ? plan[0].toUpperCase() + plan.slice(1) : '—'
}

function statusBadge(active: boolean) {
  return active
    ? <span className="text-xs px-2 py-1 rounded-full bg-green-950 text-green-300 font-semibold">Active account</span>
    : <span className="text-xs px-2 py-1 rounded-full bg-red-950 text-red-300 font-semibold">Deactivated account</span>
}

export default function ExpiredSubscriptionsDashboard() {
  const [data, setData] = useState<Payload>({ expired: [], expiringSoon: [] })
  const [loading, setLoading] = useState(true)
  const [busyUserId, setBusyUserId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/subscriptions/expired', { credentials: 'include' })
      if (res.ok) {
        const payload = await res.json()
        setData({
          expired: Array.isArray(payload.expired) ? payload.expired : [],
          expiringSoon: Array.isArray(payload.expiringSoon) ? payload.expiringSoon : [],
        })
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function deactivateAccount(userId: string) {
    setBusyUserId(userId)
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      })
      if (res.ok) await load()
    } finally {
      setBusyUserId(null)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="border-b border-gray-800 px-6 py-4 flex items-center gap-3">
        <ShieldAlert className="h-6 w-6 text-orange-500" />
        <div>
          <h1 className="text-lg font-bold">Expired Subscriptions</h1>
          <p className="text-xs text-gray-500">Expired subscriptions stay active until you deactivate them manually.</p>
        </div>
        <button onClick={() => void load()} className="ml-auto p-2 rounded-xl text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 px-6 py-5">
        <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
          <p className="text-xs text-gray-400 mb-1">Expired Subscriptions</p>
          <p className="text-3xl font-bold">{data.expired.length}</p>
        </div>
        <div className="bg-amber-950 rounded-2xl p-4 border border-amber-900">
          <p className="text-xs text-amber-300 mb-1">Expiring In 7 Days</p>
          <p className="text-3xl font-bold text-amber-300">{data.expiringSoon.length}</p>
        </div>
        <div className="bg-green-950 rounded-2xl p-4 border border-green-900">
          <p className="text-xs text-green-300 mb-1">Still Active After Expiry</p>
          <p className="text-3xl font-bold text-green-300">{data.expired.filter((row) => row.isActive).length}</p>
        </div>
      </div>

      <AdminNav />

      <div className="px-6 pb-10 space-y-6">
        <section className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <h2 className="font-semibold">Expiring In Next 7 Days</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-950/70 text-gray-400">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Restaurant Name</th>
                  <th className="text-left px-4 py-3 font-medium">Plan</th>
                  <th className="text-left px-4 py-3 font-medium">Days Remaining</th>
                  <th className="text-left px-4 py-3 font-medium">Subscription Status</th>
                  <th className="text-left px-4 py-3 font-medium">Account Status</th>
                </tr>
              </thead>
              <tbody>
                {data.expiringSoon.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-500">No subscriptions expiring in the next 7 days.</td>
                  </tr>
                ) : data.expiringSoon.map((row) => (
                  <tr key={row.restaurantId} className="border-t border-gray-800">
                    <td className="px-4 py-3 font-medium text-white">{row.restaurantName}</td>
                    <td className="px-4 py-3 text-gray-300">{planLabel(row.plan)}</td>
                    <td className="px-4 py-3 text-amber-300 font-medium">{row.daysRemaining} day{row.daysRemaining === 1 ? '' : 's'} left</td>
                    <td className="px-4 py-3"><span className="text-xs px-2 py-1 rounded-full bg-green-950 text-green-300 font-semibold">Active subscription</span></td>
                    <td className="px-4 py-3">{statusBadge(row.isActive)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-orange-400" />
            <h2 className="font-semibold">Expired Subscriptions</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-950/70 text-gray-400">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Restaurant Name</th>
                  <th className="text-left px-4 py-3 font-medium">Plan Name</th>
                  <th className="text-left px-4 py-3 font-medium">Subscription Activated At</th>
                  <th className="text-left px-4 py-3 font-medium">Subscription Expiry Date</th>
                  <th className="text-left px-4 py-3 font-medium">Days Overdue</th>
                  <th className="text-left px-4 py-3 font-medium">Subscription Status</th>
                  <th className="text-left px-4 py-3 font-medium">Account Status</th>
                  <th className="text-left px-4 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.expired.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-gray-500">No expired subscriptions found.</td>
                  </tr>
                ) : data.expired.map((row) => (
                  <tr key={row.restaurantId} className="border-t border-gray-800 align-top">
                    <td className="px-4 py-3 font-medium text-white">{row.restaurantName}</td>
                    <td className="px-4 py-3 text-gray-300">{planLabel(row.plan)}</td>
                    <td className="px-4 py-3 text-gray-300">{formatDate(row.subscriptionActivatedAt)}</td>
                    <td className="px-4 py-3 text-gray-300">{formatDate(row.subscriptionExpiry)}</td>
                    <td className="px-4 py-3 text-red-300 font-medium">Expired {row.daysOverdue} day{row.daysOverdue === 1 ? '' : 's'} ago</td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-1 rounded-full bg-amber-950 text-amber-300 font-semibold">Expired subscription</span>
                    </td>
                    <td className="px-4 py-3">{statusBadge(row.isActive)}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => void deactivateAccount(row.userId)}
                        disabled={!row.isActive || busyUserId === row.userId}
                        className="px-3 py-2 rounded-xl bg-red-700 hover:bg-red-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed text-white font-semibold transition-colors"
                      >
                        {busyUserId === row.userId ? 'Deactivating...' : row.isActive ? 'Deactivate Account' : 'Already Deactivated'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}
'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RefreshCw } from 'lucide-react'
import { signOut } from 'next-auth/react'

type RestaurantBootstrapGateProps = {
  initialMessage?: string | null
}

export default function RestaurantBootstrapGate({ initialMessage }: RestaurantBootstrapGateProps) {
  const router = useRouter()
  const autoStartedRef = useRef(false)
  const [syncing, setSyncing] = useState(true)
  const [message, setMessage] = useState(
    initialMessage || 'Loading restaurant data on this device. Keep this screen open while bootstrap runs.'
  )

  async function retryBootstrap() {
    setSyncing(true)
    setMessage('Loading restaurant data on this device. Keep this screen open while bootstrap runs.')

    try {
      const res = await fetch('/api/restaurant/bootstrap-status', {
        method: 'GET',
        credentials: 'include',
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(payload?.error || 'Unable to check bootstrap status.')
      }
      if (payload?.ready) {
        router.refresh()
        return
      }
      throw new Error(
        payload?.message ||
        'Restaurant data is not ready on this device yet. Ensure you have set up your restaurant through the portal and try again.'
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load restaurant data right now.')
      setSyncing(false)
    }
  }

  useEffect(() => {
    if (autoStartedRef.current) return
    autoStartedRef.current = true
    void retryBootstrap()
  }, [])

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="mx-auto flex min-h-[70vh] max-w-lg items-center justify-center">
        <div className="w-full rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-orange-100 text-orange-700">
              {syncing ? <Loader2 className="h-5 w-5 animate-spin" /> : <RefreshCw className="h-5 w-5" />}
            </div>
            <div>
              <h1 className="text-lg font-semibold text-gray-900">Loading restaurant data</h1>
              <p className="text-sm text-gray-600">This device cannot open the restaurant until bootstrap finishes.</p>
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
            {message}
          </div>

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={() => void retryBootstrap()}
              disabled={syncing}
              className="inline-flex flex-1 items-center justify-center rounded-xl bg-orange-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {syncing ? 'Syncing…' : 'Retry sync'}
            </button>
            <button
              type="button"
              onClick={() => void signOut({ callbackUrl: '/login' })}
              className="inline-flex items-center justify-center rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold text-gray-700 transition hover:bg-gray-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
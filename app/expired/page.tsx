'use client'
import { signOut } from 'next-auth/react'
import { AlertTriangle, LogOut, RefreshCw } from 'lucide-react'

export default function ExpiredPage() {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 rounded-2xl bg-red-600 flex items-center justify-center mx-auto">
          <AlertTriangle className="h-8 w-8 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white mb-2">Subscription Expired</h1>
          <p className="text-gray-400 text-sm leading-relaxed">
            Your free trial or license has ended. Contact Magnify support to renew your subscription and regain access.
          </p>
        </div>

        <div className="bg-gray-900 rounded-2xl p-6 border border-gray-700 text-left space-y-3">
          <p className="text-xs font-bold uppercase tracking-widest text-orange-500">How to renew</p>
          <p className="text-sm text-gray-300">
            Reach out to your app provider to make a monthly payment and get your license re-activated.
          </p>
          <p className="text-sm text-gray-300">
            Once payment is confirmed, your access will be restored automatically — no reinstall needed.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <button
            onClick={() => window.location.reload()}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-semibold transition-colors"
          >
            <RefreshCw className="h-4 w-4" /> Check Again
          </button>
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium transition-colors"
          >
            <LogOut className="h-4 w-4" /> Sign Out
          </button>
        </div>
      </div>
    </div>
  )
}

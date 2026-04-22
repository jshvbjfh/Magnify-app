'use client'

import { useEffect, useState } from 'react'
import { Loader2, LogIn, Phone } from 'lucide-react'
import Link from 'next/link'
import Image from 'next/image'

type Plan = {
  id: string
  name: string
  duration: number
  price: number
  currency: string
}

type PricingResponse = {
  state: 'ready' | 'pricing_unavailable' | 'bootstrap_failed'
  plans: Plan[]
  lastError?: string | null
}

const PLAN_ORDER = [1, 3, 6, 12]

function durationLabel(months: number) {
  if (months === 1) return '/mo'
  if (months === 12) return '/year'
  return `/${months} mo`
}

function savingsText(plans: Plan[], plan: Plan) {
  const monthly = plans.find(p => p.duration === 1)
  if (!monthly || plan.duration <= 1) return null
  const savings = (monthly.price * plan.duration) - plan.price
  if (savings <= 0) return null
  return (
    <span className="inline-block mt-4 bg-orange-500/20 text-orange-400 border border-orange-500/30 text-xs font-bold px-3 py-1.5 rounded-lg">
      Save {savings.toLocaleString()} RWF
    </span>
  )
}

export default function PricingPage() {
  const [plans, setPlans] = useState<Plan[]>([])
  const [pricingState, setPricingState] = useState<PricingResponse['state']>('ready')
  const [lastError, setLastError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/pricing')
      .then(r => r.json())
      .then((data: PricingResponse) => {
        setPricingState(data.state)
        setLastError(data.lastError ?? null)
        setPlans(Array.isArray(data.plans) ? data.plans : [])
      })
      .finally(() => setLoading(false))
  }, [])

  const orderedPlans = PLAN_ORDER
    .map(duration => plans.find(plan => plan.duration === duration) ?? null)
    .filter((plan): plan is Plan => plan !== null)

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Header */}
      <div className="border-b border-gray-800 px-4 py-4 sm:px-6 flex items-center gap-3">
        <div className="h-9 w-9 rounded-xl overflow-hidden">
          <Image src="/icon.png" alt="Magnify" width={36} height={36} className="h-9 w-9 object-cover" />
        </div>
        <span className="font-bold text-base sm:text-lg">Magnify</span>
        <Link href="/login" className="ml-auto flex items-center gap-1.5 text-xs sm:text-sm text-gray-400 hover:text-white transition-colors">
          <LogIn className="h-4 w-4" /> Sign in
        </Link>
      </div>

      {/* Hero */}
      <div className="text-center px-4 pt-8 pb-4 sm:pt-12 sm:pb-6">
        <div className="inline-block bg-orange-500/10 text-orange-400 text-xs font-bold uppercase tracking-widest px-4 py-2 rounded-full border border-orange-500/20 mb-4">
          Simple Pricing
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold mb-3">Activate Your Account</h1>
        <p className="text-gray-400 text-sm max-w-md mx-auto">
          New accounts and expired subscriptions renew from the same pricing page. Choose a duration below, pay, then send your receipt for activation.
        </p>
      </div>

      {/* Plans */}
      <div className="flex-1 px-4 pb-6 sm:px-6">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
          </div>
        ) : pricingState === 'bootstrap_failed' ? (
          <div className="text-center py-16 text-red-300">
            <p className="text-lg font-semibold mb-2">Pricing setup failed</p>
            <p className="text-sm text-red-200/80">The app could not load the required pricing catalog on this device.</p>
            {lastError ? <p className="text-xs text-red-200/60 mt-3">{lastError}</p> : null}
          </div>
        ) : plans.length === 0 ? (
          <div className="text-center py-16 text-gray-500">
            <p className="text-lg font-semibold mb-2">Pricing unavailable</p>
            <p className="text-sm">Active plans are currently disabled. Contact us to get started.</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto">
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
              {orderedPlans.map((plan) => {
                const isYearly = plan.duration === 12
                return (
                  <div
                    key={plan.id}
                    className={`rounded-2xl border p-4 sm:p-8 shadow-xl transition-transform hover:-translate-y-0.5 ${
                      isYearly
                        ? 'border-orange-500/60 bg-gradient-to-br from-gray-900 via-gray-900 to-orange-950/40 shadow-orange-900/30'
                        : 'border-gray-800 bg-gray-900 shadow-black/20'
                    }`}
                  >
                    <p className={`text-base font-bold tracking-wide ${
                      isYearly ? 'text-orange-400' : 'text-gray-300'
                    }`}>{plan.name}</p>
                    <div className="mt-3 sm:mt-5 flex items-end gap-1.5">
                      <span className="text-xs sm:text-sm font-semibold text-gray-500 mb-1">{plan.currency}</span>
                      <span className="text-3xl sm:text-5xl font-extrabold tracking-tight text-white leading-none">
                        {plan.price.toLocaleString()}
                      </span>
                    </div>
                    <p className={`mt-2 text-sm font-medium ${
                      isYearly ? 'text-orange-400/80' : 'text-gray-500'
                    }`}>{durationLabel(plan.duration)}</p>
                    {savingsText(plans, plan)}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Contact & Actions */}
      <div className="border-t border-gray-800 px-4 py-6 sm:px-6 sm:py-8 max-w-3xl mx-auto w-full">
        {/* Contact info box */}
        <div className="rounded-2xl border border-gray-700 bg-gray-900 p-5 flex flex-col sm:flex-row gap-4 items-start sm:items-center">
          <div className="flex-1">
            <p className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-1">MTN MoMo Payment</p>
            <p className="text-xl sm:text-2xl font-extrabold text-white tracking-wider">Code: 3445</p>
          </div>
          <div className="h-px w-full sm:h-12 sm:w-px bg-gray-700" />
          <div className="flex-1">
            <p className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-1">Phone / WhatsApp</p>
            <a href="tel:+250783714720" className="break-all sm:break-normal text-lg sm:text-2xl font-extrabold text-orange-400 hover:text-orange-300 transition-colors tracking-wide sm:tracking-wide">
              +250 783 714 720
            </a>
          </div>
        </div>

        <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/login"
            className="flex items-center justify-center gap-2 px-6 py-3 rounded-2xl bg-orange-600 hover:bg-orange-700 text-white font-semibold text-sm transition-colors"
          >
            <LogIn className="h-4 w-4" /> Already activated? Sign in
          </Link>
          <a
            href="https://wa.me/250783714720"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 px-6 py-3 rounded-2xl bg-gray-800 hover:bg-gray-700 text-white font-semibold text-sm transition-colors"
          >
            <Phone className="h-4 w-4" /> Contact us on WhatsApp
          </a>
        </div>
      </div>
    </main>
  )
}

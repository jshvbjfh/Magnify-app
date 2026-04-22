export const APP_SCHEMA_STATE_KEY = 'primary'
export const APP_SCHEMA_VERSION = 20260421
export const SYNC_PROTOCOL_VERSION = 2
export const BOOTSTRAP_VERSION = 1

export type BootstrapPricingPlan = {
  seedKey: string
  name: string
  duration: number
  price: number
  currency: string
}

export const DEFAULT_PRICING_PLANS: BootstrapPricingPlan[] = [
  { seedKey: 'pricing.monthly', name: 'Monthly', duration: 1, price: 250000, currency: 'RWF' },
  { seedKey: 'pricing.quarterly', name: '3 Months', duration: 3, price: 700000, currency: 'RWF' },
  { seedKey: 'pricing.biannual', name: '6 Months', duration: 6, price: 1250000, currency: 'RWF' },
  { seedKey: 'pricing.yearly', name: 'Yearly', duration: 12, price: 2500000, currency: 'RWF' },
]
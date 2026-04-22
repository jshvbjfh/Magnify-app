export const FIFO_FEATURE_AVAILABLE = true

export const FIFO_DEVELOPMENT_MESSAGE = 'FIFO costing is enabled for all restaurants in this build.'

export function getStoredFifoEnabled(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }

  return false
}

export function getEffectiveFifoEnabled(value: unknown, featureAvailable = FIFO_FEATURE_AVAILABLE) {
  return featureAvailable && Boolean(value)
}
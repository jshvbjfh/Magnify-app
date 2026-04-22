const MS_PER_DAY = 86400000

export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function endOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
}

export function parseSubscriptionExpiryInput(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 23, 59, 59, 999)
}

export function isSubscriptionExpired(expiry: Date | null | undefined, now = new Date()) {
  if (!expiry) return false
  return now.getTime() > endOfDay(expiry).getTime()
}

export function getDaysOverdue(expiry: Date, now = new Date()) {
  return Math.max(0, Math.ceil((startOfDay(now).getTime() - startOfDay(expiry).getTime()) / MS_PER_DAY))
}

export function getDaysRemaining(expiry: Date, now = new Date()) {
  return Math.max(0, Math.ceil((startOfDay(expiry).getTime() - startOfDay(now).getTime()) / MS_PER_DAY))
}
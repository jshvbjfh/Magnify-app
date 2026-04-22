function pad(value: number) {
  return String(value).padStart(2, '0')
}

function createRandomBatchSeed() {
  const randomUuid = globalThis.crypto?.randomUUID?.()
  if (randomUuid) return randomUuid.replace(/-/g, '')

  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
}

export function createInventoryBatchSuffix() {
  return createRandomBatchSeed().slice(0, 6).toUpperCase()
}

export function formatInventoryBatchId(date = new Date(), suffix = createInventoryBatchSuffix()) {
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const year = date.getFullYear()

  return `B-${month}${day}${year}-${suffix.toUpperCase()}`
}

export function generateInventoryBatchId(date = new Date()) {
  return formatInventoryBatchId(date, createInventoryBatchSuffix())
}
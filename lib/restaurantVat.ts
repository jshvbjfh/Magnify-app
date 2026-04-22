export const RESTAURANT_VAT_RATE = 0.18

export function calculateVatFromNet(netAmount: number) {
  return Number(netAmount) * RESTAURANT_VAT_RATE
}

export function calculateGrossFromNet(netAmount: number) {
  return Number(netAmount) + calculateVatFromNet(netAmount)
}

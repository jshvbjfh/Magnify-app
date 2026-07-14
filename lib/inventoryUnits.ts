export const INVENTORY_UNITS = [
	{ value: 'kg', label: 'Kg' },
	{ value: 'g', label: 'g' },
	{ value: 'ltr', label: 'Ltr' },
	{ value: 'ml', label: 'ml' },
	{ value: 'piece', label: 'Piece' },
	{ value: 'shot', label: 'Shot' },
	{ value: 'bottle', label: 'Bottle' },
	{ value: 'bag', label: 'Bag' },
	{ value: 'box', label: 'Box' },
	{ value: 'bunch', label: 'Bunch' },
	{ value: 'can', label: 'Can' },
	{ value: 'sachet', label: 'Sachet' },
] as const

export const DEFAULT_USAGE_UNIT_BY_PURCHASE_UNIT: Record<string, string> = {
	bottle: 'ml',
	can: 'ml',
	sachet: 'ml',
	bag: 'g',
	box: 'piece',
	bunch: 'g',
}

const UNIT_EPSILON = 0.000001

// Fixed metric conversions — prefilled in the purchase form so users don't
// type 1000 by hand (and can't typo it).
const KNOWN_UNIT_CONVERSIONS: Record<string, number> = {
	'kg->g': 1000,
	'ltr->ml': 1000,
}

export function getKnownUnitConversion(purchaseUnit: string | null | undefined, usageUnit: string | null | undefined): number | null {
	const key = `${canonicalInventoryUnit(purchaseUnit)}->${canonicalInventoryUnit(usageUnit)}`
	return KNOWN_UNIT_CONVERSIONS[key] ?? null
}

type DualUnitLike = {
	unit?: string | null
	purchaseUnit?: string | null
	unitsPerPurchaseUnit?: number | null
}

type PurchaseDualUnitLike = DualUnitLike & {
	quantityPurchased?: number | null
	unitCost?: number | null
	purchaseQuantity?: number | null
	purchaseUnitCost?: number | null
}

function roundQuantity(value: number) {
	return Math.round(value * 1000) / 1000
}

export function normalizeInventoryUnit(unit: string | null | undefined) {
	return String(unit ?? '').trim()
}

// Spelling variants of the same physical unit. Items created before the unit
// dropdown existed hold free-typed values like "pcs" — treating those as a
// different unit from "piece" wrongly triggered the usage-unit-change guard.
const UNIT_ALIASES: Record<string, string> = {
	pc: 'piece', pcs: 'piece', pieces: 'piece',
	l: 'ltr', litre: 'ltr', liter: 'ltr', litres: 'ltr', liters: 'ltr',
	gram: 'g', grams: 'g', gr: 'g',
	kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
	mls: 'ml',
	bottles: 'bottle', bags: 'bag', boxes: 'box', cans: 'can',
	sachets: 'sachet', bunches: 'bunch', shots: 'shot',
}

export function canonicalInventoryUnit(unit: string | null | undefined) {
	const normalized = normalizeInventoryUnit(unit).toLowerCase()
	return UNIT_ALIASES[normalized] ?? normalized
}

export function isSameInventoryUnit(a: string | null | undefined, b: string | null | undefined) {
	return canonicalInventoryUnit(a) === canonicalInventoryUnit(b)
}

// Every purchase unit may track usage in a different unit (buy in kg, use in
// g; buy in bottle, use in ml) — so the dual-unit form shows for any unit.
export function isDualUnitPurchaseUnit(unit: string | null | undefined) {
	return normalizeInventoryUnit(unit) !== ''
}

export function normalizeUnitsPerPurchaseUnit(value: unknown, fallback = 1) {
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback
	return parsed
}

export function getUsageUnit(config: DualUnitLike | null | undefined) {
	return normalizeInventoryUnit(config?.unit)
}

export function getPurchaseUnit(config: DualUnitLike | null | undefined) {
	const usageUnit = getUsageUnit(config)
	return normalizeInventoryUnit(config?.purchaseUnit) || usageUnit
}

export function getUnitsPerPurchaseUnit(config: DualUnitLike | null | undefined) {
	const usageUnit = getUsageUnit(config)
	if (!usageUnit || isSameInventoryUnit(usageUnit, getPurchaseUnit(config))) return 1
	return normalizeUnitsPerPurchaseUnit(config?.unitsPerPurchaseUnit, 1)
}

export function usesSeparatePurchaseUnit(config: DualUnitLike | null | undefined) {
	return !isSameInventoryUnit(getPurchaseUnit(config), getUsageUnit(config))
		|| Math.abs(getUnitsPerPurchaseUnit(config) - 1) > UNIT_EPSILON
}

export function toUsageQuantity(purchaseQuantity: number, unitsPerPurchaseUnit: number) {
	return roundQuantity(Number(purchaseQuantity || 0) * normalizeUnitsPerPurchaseUnit(unitsPerPurchaseUnit, 1))
}

export function toUsageUnitCost(purchaseUnitCost: number, unitsPerPurchaseUnit: number) {
	const factor = normalizeUnitsPerPurchaseUnit(unitsPerPurchaseUnit, 1)
	if (factor <= 0) return 0
	return roundQuantity(Number(purchaseUnitCost || 0) / factor)
}

export function toPurchaseQuantity(usageQuantity: number, unitsPerPurchaseUnit: number) {
	const factor = normalizeUnitsPerPurchaseUnit(unitsPerPurchaseUnit, 1)
	if (factor <= 0) return 0
	return roundQuantity(Number(usageQuantity || 0) / factor)
}

export function toPurchaseUnitCost(usageUnitCost: number, unitsPerPurchaseUnit: number) {
	return roundQuantity(Number(usageUnitCost || 0) * normalizeUnitsPerPurchaseUnit(unitsPerPurchaseUnit, 1))
}

export function derivePurchaseQuantity(config: PurchaseDualUnitLike) {
	if (config.purchaseQuantity != null && Number.isFinite(Number(config.purchaseQuantity))) {
		return Number(config.purchaseQuantity)
	}
	return toPurchaseQuantity(Number(config.quantityPurchased || 0), getUnitsPerPurchaseUnit(config))
}

export function derivePurchaseUnitCost(config: PurchaseDualUnitLike) {
	if (config.purchaseUnitCost != null && Number.isFinite(Number(config.purchaseUnitCost))) {
		return Number(config.purchaseUnitCost)
	}
	return toPurchaseUnitCost(Number(config.unitCost || 0), getUnitsPerPurchaseUnit(config))
}

export function splitUsageQuantity(quantity: number, unitsPerPurchaseUnit: number) {
	const normalizedQuantity = roundQuantity(Number(quantity || 0))
	const factor = normalizeUnitsPerPurchaseUnit(unitsPerPurchaseUnit, 1)
	if (factor <= 1) {
		return {
			wholePurchaseUnits: normalizedQuantity,
			remainderUsageQuantity: 0,
			approxPurchaseUnits: normalizedQuantity,
		}
	}

	const wholePurchaseUnits = Math.floor((normalizedQuantity + UNIT_EPSILON) / factor)
	const remainderUsageQuantity = roundQuantity(normalizedQuantity - (wholePurchaseUnits * factor))
	return {
		wholePurchaseUnits,
		remainderUsageQuantity,
		approxPurchaseUnits: roundQuantity(normalizedQuantity / factor),
	}
}
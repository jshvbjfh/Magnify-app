type LayerLike = {
	id: string
	remainingQuantity: number
	unitCost: number | null
	purchasedAt?: string | Date | null
	createdAt?: string | Date | null
}

export type FifoCostAllocation = {
	layerId: string
	quantity: number
	unitCost: number
	totalCost: number
}

export type FifoCostEstimate = {
	totalCost: number
	effectiveUnitCost: number | null
	quantityRequested: number
	quantityCovered: number
	quantityRemaining: number
	allocations: FifoCostAllocation[]
}

const FIFO_COST_EPSILON = 0.000001

function roundQuantity(value: number) {
	return Math.round(value * 1000) / 1000
}

function toTimestamp(value?: string | Date | null) {
	if (!value) return 0
	const timestamp = new Date(value).getTime()
	return Number.isFinite(timestamp) ? timestamp : 0
}

export function compareFifoLayers(left: LayerLike, right: LayerLike) {
	return toTimestamp(left.purchasedAt) - toTimestamp(right.purchasedAt)
		|| toTimestamp(left.createdAt) - toTimestamp(right.createdAt)
		|| left.id.localeCompare(right.id)
}

export function getActiveFifoUnitCost(layers: LayerLike[], fallbackUnitCost: number | null = null) {
	const nextLayer = layers
		.filter((layer) => Number(layer.remainingQuantity || 0) > FIFO_COST_EPSILON)
		.slice()
		.sort(compareFifoLayers)[0]

	if (!nextLayer) return fallbackUnitCost
	const nextUnitCost = Number(nextLayer.unitCost ?? 0)
	return Number.isFinite(nextUnitCost) ? nextUnitCost : fallbackUnitCost
}

export function estimateFifoCostForQuantity(
	layers: LayerLike[],
	quantityRequested: number,
	fallbackUnitCost: number | null = null,
): FifoCostEstimate {
	const requestedQuantity = roundQuantity(Number(quantityRequested || 0))
	if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
		return {
			totalCost: 0,
			effectiveUnitCost: null,
			quantityRequested: 0,
			quantityCovered: 0,
			quantityRemaining: 0,
			allocations: [],
		}
	}

	const sortedLayers = layers
		.filter((layer) => Number(layer.remainingQuantity || 0) > FIFO_COST_EPSILON)
		.slice()
		.sort(compareFifoLayers)

	let remainingQuantity = requestedQuantity
	let quantityCovered = 0
	let totalCost = 0
	const allocations: FifoCostAllocation[] = []

	for (const layer of sortedLayers) {
		if (remainingQuantity <= FIFO_COST_EPSILON) break

		const layerRemaining = roundQuantity(Number(layer.remainingQuantity || 0))
		if (layerRemaining <= FIFO_COST_EPSILON) continue

		const quantityFromLayer = roundQuantity(Math.min(layerRemaining, remainingQuantity))
		if (quantityFromLayer <= FIFO_COST_EPSILON) continue

		const unitCost = Number(layer.unitCost ?? 0)
		const allocationCost = roundQuantity(quantityFromLayer * unitCost)

		remainingQuantity = roundQuantity(remainingQuantity - quantityFromLayer)
		quantityCovered = roundQuantity(quantityCovered + quantityFromLayer)
		totalCost = roundQuantity(totalCost + allocationCost)
		allocations.push({
			layerId: layer.id,
			quantity: quantityFromLayer,
			unitCost,
			totalCost: allocationCost,
		})
	}

	const safeFallbackUnitCost = fallbackUnitCost != null && Number.isFinite(fallbackUnitCost)
		? Number(fallbackUnitCost)
		: null

	if (remainingQuantity > FIFO_COST_EPSILON && safeFallbackUnitCost != null) {
		const fallbackCost = roundQuantity(remainingQuantity * safeFallbackUnitCost)
		totalCost = roundQuantity(totalCost + fallbackCost)
		quantityCovered = roundQuantity(quantityCovered + remainingQuantity)
		allocations.push({
			layerId: 'fallback',
			quantity: remainingQuantity,
			unitCost: safeFallbackUnitCost,
			totalCost: fallbackCost,
		})
		remainingQuantity = 0
	}

	return {
		totalCost,
		effectiveUnitCost: requestedQuantity > FIFO_COST_EPSILON ? roundQuantity(totalCost / requestedQuantity) : null,
		quantityRequested: requestedQuantity,
		quantityCovered,
		quantityRemaining: remainingQuantity,
		allocations,
	}
}
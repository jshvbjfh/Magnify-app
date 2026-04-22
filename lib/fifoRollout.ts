import 'server-only'

import { FIFO_FEATURE_AVAILABLE } from '@/lib/fifoFeature'

type FifoRestaurantTarget = {
	id?: string | null
	syncRestaurantId?: string | null
	fifoCutoverAt?: Date | null
}

function getConfiguredPilotTokens() {
	return new Set(
		String(process.env.FIFO_PILOT_RESTAURANTS || '')
			.split(/[\r\n,]+/)
			.map((value) => value.trim())
			.filter(Boolean),
	)
}

export function getRestaurantFifoAvailability(restaurant: FifoRestaurantTarget | null | undefined) {
	if (FIFO_FEATURE_AVAILABLE) return true
	if (!restaurant) return false

	const configuredTokens = getConfiguredPilotTokens()
	if (configuredTokens.size === 0) return false

	return [restaurant.id, restaurant.syncRestaurantId].some(
		(value) => typeof value === 'string' && configuredTokens.has(value),
	)
}

export function getRestaurantFifoRuntimeAvailability(restaurant: FifoRestaurantTarget | null | undefined) {
	return getRestaurantFifoAvailability(restaurant) && Boolean(restaurant?.fifoCutoverAt)
}
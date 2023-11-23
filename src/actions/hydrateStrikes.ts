import { getSurroundingStrikes } from '../utils/strikes'
import { marketParams } from '../config'

// NOTE: only runs if strike arrays are NOT populated AND we have a spot price for the market
export async function hydrateStrikes(market: string, spotPrice: number) {
	if (!spotPrice) return

	if (!marketParams[market].callStrikes) {
		marketParams[market].callStrikes = getSurroundingStrikes(spotPrice)
	}

	if (!marketParams[market].putStrikes) {
		marketParams[market].putStrikes = getSurroundingStrikes(spotPrice)
	}
}

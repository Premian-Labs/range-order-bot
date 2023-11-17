import { getSurroundingStrikes } from '../utils/strikes'
import { marketParams } from '../config/index.example'

// NOTE: only run if EITHER strike array is NOT populated AND we have a spot price for the market
export async function hydrateStrikes(market: string, spotPrice: number) {
	if (!marketParams[market].callStrikes && spotPrice !== undefined) {
		marketParams[market].callStrikes = getSurroundingStrikes(spotPrice)
	}

	if (!marketParams[market].putStrikes && spotPrice !== undefined) {
		marketParams[market].putStrikes = getSurroundingStrikes(spotPrice)
	}

	return
}

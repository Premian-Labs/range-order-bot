import { getSurroundingStrikes } from '../utils/strikes'
import { marketParams } from '../config/index.example'
import { WAD_DECIMALS } from '@premia/v3-sdk'

// NOTE: only ran if EITHER strike array is not populated AND we have a spot price for the market
export async function hydrateStrikes(
	market: string
) {
	const spotPrice = marketParams[market].spotPrice

	if (!marketParams[market].callStrikes && spotPrice) {
		marketParams[market].callStrikes = getSurroundingStrikes(spotPrice!)
	}

	if (!marketParams[market].putStrikes && spotPrice) {
		marketParams[market].putStrikes = getSurroundingStrikes(spotPrice!)
	}

	return
}

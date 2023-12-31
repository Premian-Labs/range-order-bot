import {
	filterSurroundingStrikes,
	getSurroundingStrikes,
} from '../utils/strikes'
import { autoGenerateStrikes, marketParams } from '../config'
import { createExpiration, getTTM } from '../utils/dates'
import { log } from '../utils/logs'

/*
	NOTE: only runs if strike arrays are NOT populated AND we have a spot price for the market
	Since the suggested strikes is very broad, we narrow it down by min/max delta to more efficient
	downstream processing and error/warning messages.
	
	IMPORTANT: we filter by the delta by the FURTHEST exp (the broadest possible strike filter)
 */
export async function hydrateStrikes(market: string, spotPrice: number) {
	if (!spotPrice) return

	// NOTE: protection incase a user accidentally omitted key:value for a set of strikes
	if (
		(!marketParams[market].callStrikes || !marketParams[market].putStrikes) &&
		!autoGenerateStrikes
	) {
		log.warning(
			`key:value marketParam is required for BOTH call/put strikes if autoGenerateStrikes is set to false`,
		)
		marketParams[market].callStrikes = marketParams[market].callStrikes ?? []
		marketParams[market].putStrikes = marketParams[market].putStrikes ?? []
		return
	}

	const longestMaturity = marketParams[market].maturities.slice(-1)[0]
	const maturityTimestamp = createExpiration(longestMaturity)
	const ttm = getTTM(maturityTimestamp)

	if (!marketParams[market].callStrikes) {
		const unFilteredCallStrikes = getSurroundingStrikes(spotPrice)

		marketParams[market].callStrikes = await filterSurroundingStrikes(
			market,
			ttm,
			spotPrice,
			true,
			unFilteredCallStrikes,
		)

		log.debug(`Call strikes set to: ${marketParams[market].callStrikes}`)
	}

	if (!marketParams[market].putStrikes) {
		const unFilteredPutStrikes = getSurroundingStrikes(spotPrice)

		marketParams[market].putStrikes = await filterSurroundingStrikes(
			market,
			ttm,
			spotPrice,
			false,
			unFilteredPutStrikes,
		)

		log.debug(`Put strikes set to: ${marketParams[market].putStrikes}`)
	}
}

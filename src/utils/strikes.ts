import { MarketParams } from './types'
import { formatEther, parseEther } from 'ethers'
import { productionTokenAddr } from '../config/constants'
import { maxDelta, minDelta, riskFreeRate } from '../config/config'
import { BlackScholes, Option } from '@uqee/black-scholes'
import { getTTM } from './dates'
import { premia, ivOracle } from '../config/contracts'
import { log } from './logs'

const blackScholes: BlackScholes = new BlackScholes()

export async function getValidStrikes(
	market: string,
	spotPrice: number,
	marketParams: MarketParams,
	maturityString: string,
	maturityTimestamp: number,
	isCall: boolean,
) {
	const strikes = isCall
		? marketParams[market].callStrikes
		: marketParams[market].putStrikes

	/*
	getSuggestedStrike() =>  will look for valid strikes from (.5 * spot) to (2 * spot) using
	our algorithmic logic for valid strike intervals.
	 */
	const suggestedStrikes =
		strikes ??
		premia.options
			.getSuggestedStrikes(parseEther(spotPrice.toString()))
			.map((strike) => Number(formatEther(strike)))

	const validStrikes: {
		strike: number
		option: Option
	}[] = []

	const ttm = getTTM(maturityTimestamp)

	// NOTE: we use a multicallProvider for the ivOracle query
	await Promise.all(
		suggestedStrikes.map(async (strike) => {
			const iv = await ivOracle[
				'getVolatility(address,uint256,uint256,uint256)'
			](
				productionTokenAddr[market], // NOTE: we use production addresses only
				parseEther(spotPrice.toString()),
				parseEther(strike.toString()),
				parseEther(
					ttm.toLocaleString(undefined, { maximumFractionDigits: 18 }),
				),
			)

			const option: Option = blackScholes.option({
				rate: riskFreeRate,
				sigma: parseFloat(formatEther(iv)),
				strike,
				time: ttm,
				type: isCall ? 'call' : 'put',
				underlying: spotPrice,
			})

			const maxDeltaThreshold = Math.abs(option.delta) > maxDelta
			const minDeltaThreshold = Math.abs(option.delta) < minDelta

			if (strikes && (maxDeltaThreshold || minDeltaThreshold)) {
				log.warning(
					`Skipping ${market} ${maturityString} ${isCall ? 'Calls' : 'Puts'}`,
				)

				log.warning(`Option out of delta range. Delta: ${option.delta}`)
				return
			} else if (maxDeltaThreshold || minDeltaThreshold) {
				/*
				TODO: need a warning if a market is not being traded for delta range reasons
				NOTE: there are a large number of non applicable strikes that come back if you use
				getSuggestedStrikes() which might make logging excessive.
				 */
				return
			}

			log.debug(
				`Adding valid strike: ${strike} with delta: ${option.delta} (${minDelta} <-> ${maxDelta})`,
			)

			validStrikes.push({
				strike,
				option,
			})
		}),
	)

	return validStrikes
}

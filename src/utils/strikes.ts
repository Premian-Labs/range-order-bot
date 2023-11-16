import { MarketParams } from './types'
import { BigNumberish, formatEther, parseEther, toBigInt } from 'ethers'
import { productionTokenAddr } from '../config/constants'
import { maxDelta, minDelta, riskFreeRate } from '../config'
import { BlackScholes, Option } from '@uqee/black-scholes'
import { getTTM } from './dates'
import { ivOracle } from '../config/contracts'
import { log } from './logs'
import { WAD_DECIMALS, ZERO_BI, parseNumber } from '@premia/v3-sdk'

const blackScholes: BlackScholes = new BlackScholes()

export async function getValidStrikes(
	market: string,
	spotPrice: number,
	marketParams: MarketParams,
	maturityString: string,
	maturityTimestamp: number,
	isCall: boolean,
) {
	//NOTE: we know there are values as we populate them in hydrateStrikes()
	const strikes = isCall
		? marketParams[market].callStrikes!
		: marketParams[market].putStrikes!

	const validStrikes: {
		strike: number
		option: Option
	}[] = []

	const ttm = getTTM(maturityTimestamp)

	// NOTE: we use a multicallProvider for the ivOracle query
	await Promise.all(
		strikes.map(async (strike) => {
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

			if (maxDeltaThreshold || minDeltaThreshold) {
				log.warning(
					`Skipping ${market} ${maturityString} ${isCall ? 'Calls' : 'Puts'}`,
				)

				log.warning(`Option out of delta range. Delta: ${option.delta}`)
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

// TODO: review code logic
export function getSurroundingStrikes(
	spotPrice: BigNumberish,
	decimals: number | bigint = WAD_DECIMALS,
): bigint[] {
	const _decimals = Number(decimals)
	const _spotPrice = toBigInt(spotPrice)

	let increment = getStrikeIncrementBelow(spotPrice, _decimals)

	if (increment === ZERO_BI) {
		return []
	}

	const maxProportion = 2n

	const minStrike = _spotPrice / maxProportion
	const maxStrike = _spotPrice * maxProportion

	let minStrikeRounded = roundToNearest(minStrike, increment)
	let maxStrikeRounded = roundToNearest(maxStrike, increment)

	if (minStrikeRounded > minStrike) {
		minStrikeRounded -= increment
	}

	if (maxStrikeRounded < maxStrike) {
		maxStrikeRounded += increment
	}

	const strikes = []
	for (let i = minStrikeRounded; i <= maxStrikeRounded; i += increment) {
		strikes.push(i)
	}

	return strikes
}

function getStrikeIncrementBelow(
	spotPrice: BigNumberish,
	decimals: number = Number(WAD_DECIMALS),
): bigint {
	const price = parseNumber(spotPrice, decimals)
	let exponent = Math.floor(Math.log10(price))
	const multiplier = price >= 5 * 10 ** exponent ? 1 : 5

	if (multiplier === 5) {
		exponent -= 1
	}

	if (exponent - 1 < 0) {
		return (
			(toBigInt(multiplier) * toBigInt(10) ** toBigInt(decimals)) /
			toBigInt(10) ** toBigInt(Math.abs(exponent - 1))
		)
	}

	return (
		toBigInt(multiplier) *
		toBigInt(10) ** toBigInt(decimals) *
		toBigInt(10) ** toBigInt(exponent - 1)
	)
}

function roundToNearest(value: bigint, nearest: bigint): bigint {
	if (nearest === ZERO_BI) {
		return value
	}

	return (value / nearest) * nearest
}

import { MarketParams } from './types'
import { formatEther, parseEther } from 'ethers'
import { productionTokenAddr } from '../config/constants'
import { maxDelta, minDelta, riskFreeRate } from '../config'
import { BlackScholes, Option } from '@uqee/black-scholes'
import { getTTM } from './dates'
import { ivOracle } from '../config/contracts'
import { log } from './logs'

const blackScholes: BlackScholes = new BlackScholes()

export async function getStrikesAndOptions(
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

export function getSurroundingStrikes(spotPrice: number, maxProportion = 2) {
	const minStrike = spotPrice / maxProportion
	const maxStrike = spotPrice * maxProportion

	const intervalAtMinStrike = getInterval(minStrike)
	const intervalAtMaxStrike = getInterval(maxStrike)
	const properMin = roundUpTo(minStrike, intervalAtMinStrike)
	const properMax = roundUpTo(maxStrike, intervalAtMaxStrike)

	const strikes = []
	let increment = getInterval(minStrike)
	for (let i = properMin; i <= properMax; i += increment) {
		increment = getInterval(i)
		strikes.push(truncateFloat(i, increment))
	}

	return strikes
}

// Fixes JS float imprecision error
function truncateFloat(input: number, increment: number): number {
	const orderOfIncrement = Math.floor(Math.log10(increment))
	if (orderOfIncrement < 0) {
		return Number(input.toFixed(-orderOfIncrement))
	} else {
		return Number(input.toFixed(0))
	}
}

function roundUpTo(initial: number, rounding: number): number {
	return Math.ceil(initial / rounding) * rounding
}

function getInterval(price: number): number {
	const orderOfTens = Math.floor(Math.log10(price))
	const base = price / 10 ** orderOfTens
	return base < 5 ? 10 ** (orderOfTens - 1) : 5 * 10 ** (orderOfTens - 1)
}

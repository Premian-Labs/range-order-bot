import { BlackScholes, Option } from '@uqee/black-scholes'
import { formatEther, parseEther } from 'ethers'

import { minDelta, maxDelta, riskFreeRate } from '../config'
import { ivOracle } from '../config/contracts'
import { productionTokenAddr } from '../config/constants'

const blackScholes: BlackScholes = new BlackScholes()

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

export async function filterSurroundingStrikes(
	market: string,
	ttm: number,
	spotPrice: number,
	isCall: boolean,
	strikes: number[],
) {
	return await Promise.all(
		strikes.filter(async (strike) => {
			let iv: number
			try {
				iv = parseFloat(
					formatEther(
						await ivOracle['getVolatility(address,uint256,uint256,uint256)'](
							productionTokenAddr[market], // NOTE: we use production addresses only
							parseEther(spotPrice.toString()),
							parseEther(strike.toString()),
							parseEther(
								ttm.toLocaleString(undefined, { maximumFractionDigits: 18 }),
							),
						),
					),
				)
			} catch (err) {
				// NOTE: if we fail to get iv, just keep the strike (conservative method)
				return true
			}

			const option: Option = blackScholes.option({
				rate: riskFreeRate,
				sigma: iv,
				strike,
				time: ttm,
				type: isCall ? 'call' : 'put',
				underlying: spotPrice,
			})

			const optionDelta = isCall ? option.delta : Math.abs(option.delta)

			return minDelta < optionDelta && maxDelta > optionDelta
		}),
	)
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

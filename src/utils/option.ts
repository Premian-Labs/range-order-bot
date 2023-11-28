import { BlackScholes, Option } from '@uqee/black-scholes'
import { formatEther, parseEther } from 'ethers'

import { riskFreeRate } from '../config'
import { productionTokenAddr } from '../config/constants'
import { ivOracle } from '../config/contracts'
import { log } from '../utils/logs'
import { delay } from '../utils/time'

const blackScholes: BlackScholes = new BlackScholes()

export async function getGreeksAndIV(
	market: string,
	spotPrice: number | undefined,
	strike: number,
	ttm: number,
	isCall: boolean,
	retry = true,
): Promise<[number | undefined, Option | undefined]> {
	let iv: number

	if (spotPrice === undefined) {
		return [undefined, undefined]
	}

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
		await delay(2000)
		if (retry) {
			return getGreeksAndIV(market, spotPrice, strike, ttm, isCall, false)
		} else {
			log.warning(
				`Failed to get IV for ${market}-${strike}-${isCall ? 'C' : 'P'}...`,
			)
			log.warning(
				`Withdrawing range orders for ${market}-${strike}-${
					isCall ? 'C' : 'P'
				} pool if they exist..`,
			)
			return [undefined, undefined]
		}
	}

	const option: Option = blackScholes.option({
		rate: riskFreeRate,
		sigma: iv,
		strike,
		time: ttm,
		type: isCall ? 'call' : 'put',
		underlying: spotPrice,
	})

	return [iv, option]
}

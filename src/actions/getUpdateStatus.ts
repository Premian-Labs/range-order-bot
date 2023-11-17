import { OptionParams } from '../utils/types'
import { marketParams, riskFreeRate, defaultSpread } from '../config'
import { createExpiration, getTTM } from '../utils/dates'
import { BlackScholes, Option } from '@uqee/black-scholes'
import { ivOracle } from '../config/contracts'
import { productionTokenAddr } from '../config/constants'
import { formatEther, parseEther } from 'ethers/lib.esm'

const blackScholes: BlackScholes = new BlackScholes()

//TODO: since this is run prior to any deposit, pull iv Oracle logic into here as well.
//TODO: should we handle chronic IV failure in here (aka signal to withdraw all range orders)
export async function getUpdateOptionParams(
	optionParams: OptionParams[],
	market: string,
	curPrice: number,
	ts: number,
) {
	if (optionParams.length == 0) {
		/*
            INITIALIZATION CASE: No values have been established. We need a baseline. Update is set to true which
            will enable initial deposits.
         */
		for (const maturityString of marketParams[market].maturities) {
			const maturityTimestamp = createExpiration(maturityString)
			const ttm = getTTM(maturityTimestamp)

			await Promise.all(
				marketParams[market].callStrikes!.map(async (strike) => {
					const iv = await ivOracle[
						'getVolatility(address,uint256,uint256,uint256)'
					](
						productionTokenAddr[market], // NOTE: we use production addresses only
						parseEther(curPrice.toString()),
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
						type: 'call',
						underlying: curPrice,
					})

					optionParams.push({
						market,
						maturity: maturityString,
						type: 'C',
						strike,
						spotPrice: curPrice,
						ts,
						iv: parseFloat(formatEther(iv)),
						optionPrice: option.price,
						delta: option.delta,
						theta: option.theta,
						vega: option.vega,
						update: true,
					})
				}),
			)

			await Promise.all(
				marketParams[market].putStrikes!.map(async (strike) => {
					const iv = await ivOracle[
						'getVolatility(address,uint256,uint256,uint256)'
					](
						productionTokenAddr[market], // NOTE: we use production addresses only
						parseEther(curPrice.toString()),
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
						type: 'put',
						underlying: curPrice,
					})

					optionParams.push({
						market,
						maturity: maturityString,
						type: 'P',
						strike,
						spotPrice: curPrice,
						ts,
						iv: parseFloat(formatEther(iv)),
						optionPrice: option.price,
						delta: option.delta,
						theta: option.theta,
						vega: option.vega,
						update: true,
					})
				}),
			)
		}
	} else {
		/*
            MAINTENANCE CASE: if option price has moved beyond our built-in spread, we update all params and set update => true so that
            we know this markets need to go through a withdrawal/deposit cycle.
         */

		for (const maturityString of marketParams[market].maturities) {
			const maturityTimestamp = createExpiration(maturityString)
			const ttm = getTTM(maturityTimestamp)

			await Promise.all(
				marketParams[market].callStrikes!.map(async (strike) => {
					const iv = await ivOracle[
						'getVolatility(address,uint256,uint256,uint256)'
					](
						productionTokenAddr[market], // NOTE: we use production addresses only
						parseEther(curPrice.toString()),
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
						type: 'call',
						underlying: curPrice,
					})

					// NOTE: Find option using market/maturity/type/strike (should only be one)
					const optionIndex = optionParams.findIndex(
						(option) =>
							option.market === market &&
							option.maturity === maturityString &&
							option.type === 'C' &&
							option.strike === strike,
					)

					const prevOptionPrice = optionParams[optionIndex].optionPrice
					const curOptionPrice = option.price

					const optionPricePercChange =
						Math.abs(curOptionPrice - prevOptionPrice) / prevOptionPrice

					// NOTE: if option requires withdraw/reDeposit then update all option related values
					if (optionPricePercChange > defaultSpread) {
						optionParams[optionIndex].spotPrice = curPrice
						optionParams[optionIndex].ts = ts
						optionParams[optionIndex].iv = parseFloat(formatEther(iv))
						optionParams[optionIndex].delta = option.delta
						optionParams[optionIndex].theta = option.theta
						optionParams[optionIndex].vega = option.vega
						optionParams[optionIndex].update = true
					}
				}),
			)

			await Promise.all(
				marketParams[market].putStrikes!.map(async (strike) => {
					const iv = await ivOracle[
						'getVolatility(address,uint256,uint256,uint256)'
					](
						productionTokenAddr[market], // NOTE: we use production addresses only
						parseEther(curPrice.toString()),
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
						type: 'put',
						underlying: curPrice,
					})

					// NOTE: Find option using market/maturity/type/strike (should only be one)
					const optionIndex = optionParams.findIndex(
						(option) =>
							option.market === market &&
							option.maturity === maturityString &&
							option.type === 'P' &&
							option.strike === strike,
					)

					const prevOptionPrice = optionParams[optionIndex].optionPrice
					const curOptionPrice = option.price

					const optionPricePercChange =
						Math.abs(curOptionPrice - prevOptionPrice) / prevOptionPrice

					// NOTE: if option requires withdraw/reDeposit then update all option related values
					if (optionPricePercChange > defaultSpread) {
						optionParams[optionIndex].spotPrice = curPrice
						optionParams[optionIndex].ts = ts
						optionParams[optionIndex].iv = parseFloat(formatEther(iv))
						optionParams[optionIndex].delta = option.delta
						optionParams[optionIndex].theta = option.theta
						optionParams[optionIndex].vega = option.vega
						optionParams[optionIndex].update = true
					}
				}),
			)
		}
	}

	return optionParams
}

/*
EXAMPLE OBJECT:

optionParams = {
 market: WETH,
 maturity: '17Nov23`,
 type: 'C'
 strike: 1700,
 spotPrice: 1826.33,
 ts: 1700158476,
 iv: .62
 delta: .55,
 theta: -4.09
 vega: 1.13
 update: false

}
 */

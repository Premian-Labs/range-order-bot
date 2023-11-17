import { OptionParams } from '../utils/types'
import { marketParams, riskFreeRate, defaultSpread } from '../config'
import { createExpiration, getTTM } from '../utils/dates'
import { BlackScholes, Option } from '@uqee/black-scholes'
import { ivOracle } from '../config/contracts'
import { productionTokenAddr } from '../config/constants'
import { formatEther, parseEther } from 'ethers/lib.esm'

const blackScholes: BlackScholes = new BlackScholes()

//TODO: should we handle chronic IV failure in here (aka signal to withdraw all range orders)
export async function getUpdateOptionParams(
	optionParams: OptionParams[],
	market: string,
	curPrice: number,
	ts: number,
) {
	// cycle through each maturity to create/update optionsParams
	for (const maturityString of marketParams[market].maturities) {
		const maturityTimestamp = createExpiration(maturityString)
		const ttm = getTTM(maturityTimestamp)
		optionParams = await processCallsAndPuts(
			market,
			curPrice,
			ts,
			ttm,
			maturityString,
			optionParams,
		)
	}

	return optionParams
}

async function processCallsAndPuts(
	market: string,
	spotPrice: number,
	ts: number,
	ttm: number,
	maturityString: string,
	optionParams: OptionParams[],
) {
	// NOTE: we break up by call/put strikes as they may not be the same
	await Promise.all(
		// CALLS
		marketParams[market].callStrikes!.map(async (strike) => {
			const [iv, option] = await getGreeksAndIV(
				market,
				spotPrice,
				strike,
				ttm,
				true,
			)
			/*
                INITIALIZATION CASE: No values have been established. We need a baseline. Update is set to true which
                will enable initial deposits.
             */
			if (optionParams.length == 0) {
				optionParams.push({
					market,
					maturity: maturityString,
					type: 'C',
					strike,
					spotPrice: spotPrice,
					ts,
					iv,
					optionPrice: option.price,
					delta: option.delta,
					theta: option.theta,
					vega: option.vega,
					update: true,
				})
			} else {
				/*
					MAINTENANCE CASE: if option price has moved beyond our built-in spread, we update all params and set update => true so that
					we know this markets need to go through a withdrawal/deposit cycle.
				 */
				optionParams = checkForUpdate(
					optionParams,
					market,
					maturityString,
					strike,
					iv,
					option,
					spotPrice,
					ts,
					true,
				)
			}
		}),
	)

	await Promise.all(
		// PUTS
		marketParams[market].putStrikes!.map(async (strike) => {
			const [iv, option] = await getGreeksAndIV(
				market,
				spotPrice,
				strike,
				ttm,
				false,
			)
			// INITIALIZATION CASE
			if (optionParams.length == 0) {
				optionParams.push({
					market,
					maturity: maturityString,
					type: 'P',
					strike,
					spotPrice: spotPrice,
					ts,
					iv,
					optionPrice: option.price,
					delta: option.delta,
					theta: option.theta,
					vega: option.vega,
					update: true,
				})
			} else {
				// MAINTENANCE CASE
				optionParams = checkForUpdate(
					optionParams,
					market,
					maturityString,
					strike,
					iv,
					option,
					spotPrice,
					ts,
					false,
				)
			}
		}),
	)

	return optionParams
}

async function getGreeksAndIV(
	market: string,
	spotPrice: number,
	strike: number,
	ttm: number,
	isCall: boolean,
): Promise<[number, Option]> {
	const iv = await ivOracle['getVolatility(address,uint256,uint256,uint256)'](
		productionTokenAddr[market], // NOTE: we use production addresses only
		parseEther(spotPrice.toString()),
		parseEther(strike.toString()),
		parseEther(ttm.toLocaleString(undefined, { maximumFractionDigits: 18 })),
	)

	const option: Option = blackScholes.option({
		rate: riskFreeRate,
		sigma: parseFloat(formatEther(iv)),
		strike,
		time: ttm,
		type: isCall ? 'call' : 'put',
		underlying: spotPrice,
	})

	return [parseFloat(formatEther(iv)), option]
}

function checkForUpdate(
	optionParams: OptionParams[],
	market: string,
	maturityString: string,
	strike: number,
	iv: number,
	option: Option,
	spotPrice: number,
	ts: number,
	isCall: boolean,
) {
	// NOTE: Find option using market/maturity/type/strike (should only be one)
	const optionIndex = optionParams.findIndex(
		(option) =>
			option.market === market &&
			option.maturity === maturityString &&
			option.type === (isCall ? 'C' : 'P') &&
			option.strike === strike,
	)

	const prevOptionPrice = optionParams[optionIndex].optionPrice
	const curOptionPrice = option.price

	const optionPricePercChange =
		Math.abs(curOptionPrice - prevOptionPrice) / prevOptionPrice

	// NOTE: if option requires withdraw/reDeposit then update all option related values
	if (optionPricePercChange > defaultSpread) {
		optionParams[optionIndex].spotPrice = spotPrice
		optionParams[optionIndex].ts = ts
		optionParams[optionIndex].iv = iv
		optionParams[optionIndex].delta = option.delta
		optionParams[optionIndex].theta = option.theta
		optionParams[optionIndex].vega = option.vega
		optionParams[optionIndex].update = true
	}

	return optionParams
}

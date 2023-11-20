import { OptionParams, Position } from '../utils/types'
import {
	marketParams,
	riskFreeRate,
	defaultSpread,
	withdrawExistingPositions,
} from '../config'
import { createExpiration, getTTM } from '../utils/dates'
import { BlackScholes, Option } from '@uqee/black-scholes'
import { ivOracle } from '../config/contracts'
import { productionTokenAddr } from '../config/constants'
import { formatEther, parseEther } from 'ethers'
import { log } from '../utils/logs'
import { delay } from '../utils/time'

const blackScholes: BlackScholes = new BlackScholes()

/*
IMPORTANT: lpRangeOrders will hold all EXISTING and NEW positions. OptionParams should ALWAYS have
a record of new and existing positions, however, it's possible for optionParams to have MORE options than
actual positions in lpRangeOrders due to filters such at DTE and Delta.

CHEATSHEET:
cycleOrders = true/False && withdrawable = false ======> don't touch
cycleOrders = true && withdrawable = true =========> cycle market (withdraw & deposit)
cycleOrders = false && withdrawable = true ===========> tradable but not ready to cycle market
(ivOracleFailure = true OR spotOracleFailure = true) AND withdrawable ===============> withdraw only

STATE CHANGES:
cycleOrders -> updated BEFORE withdraws (in getUpdateOptionParams) and AFTER a deposit
withdrawable -> initialization only
oracleFailure -> updated BEFORE withdrawals/deposits (in getUpdateOptionParams)
 */

// IMPORTANT: can ONLY be run if BOTH call/put strikes exist in marketParams
export async function getUpdateOptionParams(
	optionParams: OptionParams[],
	lpRangeOrders: Position[],
	market: string,
	curPrice: number | undefined,
	ts: number,
) {
	// determine if this is initialization case or not (for down stream processing)
	const initialized = optionParams.length != 0

	/*
	NOTE: We need to ensure existing positions are IGNORED if a user specifies this by setting
	withdrawExistingPositions to false. Since all existing positions are populated into lpRangeOrders
	we need to populate them into optionParams.  This should only run once.
	 */
	if (!initialized && lpRangeOrders.length > 0 && !withdrawExistingPositions) {
		for (const existingPosition of lpRangeOrders) {
			optionParams.push({
				market,
				maturity: existingPosition.maturity,
				type: existingPosition.isCall ? 'C' : 'P',
				strike: existingPosition.strike,
				spotPrice: curPrice,
				ts,
				iv: undefined,
				optionPrice: undefined,
				delta: undefined,
				theta: undefined,
				vega: undefined,
				cycleOrders: true,
				ivOracleFailure: false,
				spotOracleFailure: false,
				withdrawable: false, // This is the critical boolean
			})
		}
	}

	// cycle through each maturity to create/update optionsParams from marketParam settings
	for (const maturityString of marketParams[market].maturities) {
		const maturityTimestamp = createExpiration(maturityString)
		const ttm = getTTM(maturityTimestamp)
		optionParams = await processCallsAndPuts(
			initialized,
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
	initialized: boolean,
	market: string,
	spotPrice: number | undefined,
	ts: number,
	ttm: number,
	maturityString: string,
	optionParams: OptionParams[],
) {
	// NOTE: we break up by call/put strikes as they may not be the same if user populated

	// CALLS
	await Promise.all(
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
                will enable initial deposits. If there is IV oracle failure, we set iv & option params to undefined and
                set a failure boolean which can be used to determine emergency withdraws if positions exist
             */
			if (!initialized) {
				optionParams.push({
					market,
					maturity: maturityString,
					type: 'C',
					strike,
					spotPrice,
					ts,
					iv,
					optionPrice: option?.price,
					delta: option?.delta,
					theta: option?.theta,
					vega: option?.vega,
					cycleOrders: true, // set to establish position in first cycle
					ivOracleFailure: iv === undefined,
					spotOracleFailure: spotPrice === undefined,
					withdrawable: true, // set to make tradable
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

	// PUTS
	await Promise.all(
		marketParams[market].putStrikes!.map(async (strike) => {
			const [iv, option] = await getGreeksAndIV(
				market,
				spotPrice,
				strike,
				ttm,
				false,
			)
			// INITIALIZATION CASE
			if (!initialized) {
				optionParams.push({
					market,
					maturity: maturityString,
					type: 'P',
					strike,
					spotPrice,
					ts,
					iv,
					optionPrice: option?.price,
					delta: option?.delta,
					theta: option?.theta,
					vega: option?.vega,
					cycleOrders: true, // set to establish position in first cycle
					ivOracleFailure: iv === undefined,
					spotOracleFailure: spotPrice === undefined,
					withdrawable: true, // set to make tradable
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
			log.warning(`Failed to get IV for ${market}-${strike}-${isCall}...`)
			log.warning(
				`Withdrawing range orders for ${market}-${strike}-${isCall} pool if they exist..`,
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

function checkForUpdate(
	optionParams: OptionParams[],
	market: string,
	maturityString: string,
	strike: number,
	iv: number | undefined,
	option: Option | undefined,
	spotPrice: number | undefined,
	ts: number,
	isCall: boolean,
) {
	// NOTE: Find option using market/maturity/type/strike/withdrawable (should only be one)
	const optionIndex = optionParams.findIndex(
		(option) =>
			option.market === market &&
			option.maturity === maturityString &&
			option.type === (isCall ? 'C' : 'P') &&
			option.strike === strike &&
			option.withdrawable,
	)

	/*
	NOTE: CURRENT oracle failure cases
	IMPORTANT: if iv is undefined, so should option(price & greeks).  For this reason, we can safely assume
	'option' is not undefined in the rest of the logic (!).
	 */
	if (iv === undefined || spotPrice === undefined) {
		log.warning(
			`${iv === undefined ? 'iv' : 'spot'} oracle failure for ${market}`,
		)
		optionParams[optionIndex].ivOracleFailure = iv === undefined
		optionParams[optionIndex].spotOracleFailure = spotPrice === undefined
		return optionParams
	}

	// NOTE: undefined is possible if previous attempt had an oracle failure
	const prevOptionPrice = optionParams[optionIndex].optionPrice
	const curOptionPrice = option!.price

	// NOTE: if we had a previous oracle failure, treat case similar to initialize case
	const optionPricePercChange = prevOptionPrice
		? Math.abs(curOptionPrice - prevOptionPrice) / prevOptionPrice
		: 0

	/*
	NOTE: if option requires withdraw/reDeposit then update all option related values
	IMPORTANT: this is to initiate a withdrawal/deposit cycle if EITHER and existing position
	moved or, we previously withdrew due to an oracle failure and now its back online.
	 */
	if (optionPricePercChange > defaultSpread || prevOptionPrice === undefined) {
		//NOTE: these are all non-static values in optionParams
		optionParams[optionIndex].spotPrice = spotPrice
		optionParams[optionIndex].ts = ts
		optionParams[optionIndex].iv = iv
		optionParams[optionIndex].optionPrice = curOptionPrice
		optionParams[optionIndex].delta = option!.delta
		optionParams[optionIndex].theta = option!.theta
		optionParams[optionIndex].vega = option!.vega
		optionParams[optionIndex].cycleOrders = true
		optionParams[optionIndex].ivOracleFailure = false
		optionParams[optionIndex].spotOracleFailure = false
	}

	return optionParams
}

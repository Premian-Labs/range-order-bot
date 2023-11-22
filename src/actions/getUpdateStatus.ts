import { BlackScholes, Option } from '@uqee/black-scholes'
import { formatEther, parseEther } from 'ethers'
import uniqBy from 'lodash.uniqby'

import { marketParams, riskFreeRate, defaultSpread, state } from '../config'
import { productionTokenAddr } from '../config/constants'
import { ivOracle } from '../config/contracts'
import { createExpiration, getTTM } from '../utils/dates'
import { log } from '../utils/logs'
import { delay } from '../utils/time'

const blackScholes: BlackScholes = new BlackScholes()

/*
	IMPORTANT: state.lpRangeOrders will hold all EXISTING and NEW positions. OptionParams should ALWAYS have
	a record of new and existing positions, however, it's possible for state.optionParams to have MORE options than
	actual positions in state.lpRangeOrders due to filters such at DTE and Delta.

	CHEATSHEET:
	cycleOrders = true  =========> cycle market (withdraw & deposit)
	cycleOrders = false  ===========> tradable but not ready to cycle market
	(ivOracleFailure = true OR spotOracleFailure = true) ===============> withdraw only

	STATE CHANGES:
	cycleOrders -> updated BEFORE withdraws (in getUpdateOptionParams) and AFTER a deposit
	oracleFailure -> updated BEFORE withdrawals/deposits (in getUpdateOptionParams)
 */

// IMPORTANT: can ONLY be run if BOTH call/put strikes exist in marketParams
export async function getUpdateOptionParams(
	market: string,
	curPrice: number | undefined,
	ts: number,
) {
	// If no optionParam for a given market exists, this is our initialization of that market
	const filteredOptionParams = state.optionParams.filter((option) => {
		return option.market === market
	})
	const initialized = filteredOptionParams.length > 0

	/*
		INITIALIZATION CASE: We need to ensure existing positions are IGNORED if a user specifies this by setting
		withdrawExistingPositions to false. All existing positions need to be hydrated with proper
		spot/option data. This should only run once.
	 */
	log.debug(
		`Existing Number of Range Orders for ${market}: ${state.lpRangeOrders.length}`,
	)

	// EXISTING POSITION INITIALIZATION
	if (!initialized && state.lpRangeOrders.length > 0) {
		for (const existingPosition of uniqBy(state.lpRangeOrders, 'poolAddress')) {
			const maturityTimestamp = createExpiration(existingPosition.maturity)
			const ttm = getTTM(maturityTimestamp)

			const [iv, option] = await getGreeksAndIV(
				existingPosition.market,
				curPrice,
				existingPosition.strike,
				ttm,
				existingPosition.isCall,
			)

			state.optionParams.push({
				market: existingPosition.market,
				maturity: existingPosition.maturity,
				type: existingPosition.isCall ? 'C' : 'P',
				strike: existingPosition.strike,
				spotPrice: curPrice,
				ts,
				iv: ttm > 0 ? iv : undefined,
				optionPrice: ttm > 0 ? option?.price : undefined,
				delta: ttm > 0 ? option?.delta : undefined,
				theta: ttm > 0 ? option?.theta : undefined,
				vega: ttm > 0 ? option?.vega : undefined,
				cycleOrders: true, // set to establish position in first cycle
				ivOracleFailure: iv === undefined,
				spotOracleFailure: curPrice === undefined,
			})
		}
	}

	// cycle through each maturity to create/update optionsParams from marketParam settings
	for (const maturityString of marketParams[market].maturities) {
		const maturityTimestamp = createExpiration(maturityString)
		const ttm = getTTM(maturityTimestamp)

		await processCallsAndPuts(
			initialized,
			market,
			curPrice,
			ts,
			ttm,
			maturityString,
		)
	}
}

async function processCallsAndPuts(
	initialized: boolean,
	market: string,
	spotPrice: number | undefined,
	ts: number,
	ttm: number,
	maturityString: string,
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
                INITIALIZATION CASE: No values have been established. We need a baseline. CycleOrders is set to true
                which will enable initial deposits. If there is IV oracle failure, we set iv & option params to
                undefined and set a failure boolean which can be used to determine emergency withdraws if positions
                exist
             */
			if (!initialized) {
				const duplicated = state.optionParams.some(
					(option) =>
						option.market === market &&
						option.strike === strike &&
						option.maturity === maturityString &&
						option.type === 'C',
				)

				if (!duplicated) {
					state.optionParams.push({
						market,
						maturity: maturityString,
						type: 'C',
						strike,
						spotPrice,
						ts,
						iv: ttm > 0 ? iv : undefined,
						optionPrice: ttm > 0 ? option?.price : undefined,
						delta: ttm > 0 ? option?.delta : undefined,
						theta: ttm > 0 ? option?.theta : undefined,
						vega: ttm > 0 ? option?.vega : undefined,
						cycleOrders: true, // set to establish position in first cycle
						ivOracleFailure: iv === undefined,
						spotOracleFailure: spotPrice === undefined,
					})
				}
			} else {
				/*
					MAINTENANCE CASE: if option price has moved beyond our built-in spread, we update all params and set update => true so that
					we know this markets need to go through a withdrawal/deposit cycle.
				 */
				checkForUpdate(
					market,
					maturityString,
					ttm,
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
			const notExp = ttm > 0

			const [iv, option] = await getGreeksAndIV(
				market,
				spotPrice,
				strike,
				ttm,
				false,
			)
			// INITIALIZATION CASE
			if (!initialized) {
				const duplicated = state.optionParams.some(
					(option) =>
						option.market === market &&
						option.strike === strike &&
						option.maturity === maturityString &&
						option.type === 'P',
				)
				if (!duplicated) {
					state.optionParams.push({
						market,
						maturity: maturityString,
						type: 'P',
						strike,
						spotPrice,
						ts,
						iv: ttm > 0 ? iv : undefined,
						optionPrice: ttm > 0 ? option?.price : undefined,
						delta: ttm > 0 ? option?.delta : undefined,
						theta: ttm > 0 ? option?.theta : undefined,
						vega: ttm > 0 ? option?.vega : undefined,
						cycleOrders: true, // set to establish position in first cycle
						ivOracleFailure: iv === undefined,
						spotOracleFailure: spotPrice === undefined,
					})
				}
			} else {
				// MAINTENANCE CASE
				checkForUpdate(
					market,
					maturityString,
					ttm,
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

function checkForUpdate(
	market: string,
	maturityString: string,
	ttm: number,
	strike: number,
	iv: number | undefined,
	option: Option | undefined,
	spotPrice: number | undefined,
	ts: number,
	isCall: boolean,
) {
	// NOTE: Find option using market/maturity/type/strike (should only be one)
	const optionIndex = state.optionParams.findIndex(
		(option) =>
			option.market === market &&
			option.maturity === maturityString &&
			option.type === (isCall ? 'C' : 'P') &&
			option.strike === strike,
	)

	/*
		NOTE: oracle failure cases, if option hasn't expired and iv is undefined, so should option (price & greeks).
	 */
	if ((iv === undefined || spotPrice === undefined) && ttm > 0) {
		log.warning(
			`${iv === undefined ? 'iv' : 'spot'} oracle failure for ${market}`,
		)
		state.optionParams[optionIndex].ivOracleFailure = iv === undefined
		state.optionParams[optionIndex].spotOracleFailure = spotPrice === undefined
		return
	}

	// NOTE: expiration case, we don't need to update its params
	if (ttm < 0) {
		state.optionParams[optionIndex].spotPrice = spotPrice
		state.optionParams[optionIndex].ts = ts
		state.optionParams[optionIndex].iv = undefined
		state.optionParams[optionIndex].optionPrice = undefined
		state.optionParams[optionIndex].delta = undefined
		state.optionParams[optionIndex].theta = undefined
		state.optionParams[optionIndex].vega = undefined
		state.optionParams[optionIndex].cycleOrders = true
		state.optionParams[optionIndex].ivOracleFailure = false
		state.optionParams[optionIndex].spotOracleFailure = false

		return
	}

	const prevOptionPrice = state.optionParams[optionIndex]
		? state.optionParams[optionIndex].optionPrice
		: null
	const curOptionPrice = option!.price

	// NOTE: if we had a previous oracle failure, treat case similar to initialize case
	const optionPricePercChange = prevOptionPrice
		? Math.abs(curOptionPrice - prevOptionPrice) / prevOptionPrice
		: 0

	/*
		NOTE: if option requires withdraw/reDeposit then update all option related values
		IMPORTANT: this is to initiate a withdrawal/deposit cycle if EITHER an existing position
		moved or, we previously withdrew due to an oracle failure and now its back online.
	 */
	if (optionPricePercChange > defaultSpread || prevOptionPrice === undefined) {
		// NOTE: these are all non-static values in state.optionParams
		state.optionParams[optionIndex].spotPrice = spotPrice
		state.optionParams[optionIndex].ts = ts
		state.optionParams[optionIndex].iv = iv
		state.optionParams[optionIndex].optionPrice = curOptionPrice
		state.optionParams[optionIndex].delta = option!.delta
		state.optionParams[optionIndex].theta = option!.theta
		state.optionParams[optionIndex].vega = option!.vega
		state.optionParams[optionIndex].cycleOrders = true
		state.optionParams[optionIndex].ivOracleFailure = false
		state.optionParams[optionIndex].spotOracleFailure = false
	}
}

// noinspection InfiniteLoopJS

import moment from 'moment'
import { MaxUint256 } from 'ethers'
import { withdrawSettleLiquidity } from './actions/withdrawPools'
import {
	marketParams,
	spotMoveThreshold,
	refreshRate,
	timeThresholdHrs,
	withdrawExistingPositions,
	maxCollateralApproved,
} from './config'
import { addresses } from './config/constants'
import { OptionParams, Position } from './utils/types'
import { getExistingPositions } from './actions/getPositions'
import { deployLiquidity } from './actions/hydratePools'
import { premia } from './config/contracts'
import { log } from './utils/logs'
import { delay } from './utils/time'
import { getSpotPrice } from './utils/prices'
import { setApproval } from './utils/tokens'
import { getUpdateOptionParams } from './actions/getUpdateStatus'
import { hydrateStrikes } from './actions/hydrateStrikes'

let initialized = false
let lpRangeOrders: Position[] = []
let optionParams: OptionParams[] = []

async function initializePositions(lpRangeOrders: Position[], market: string) {
	log.app(`Initializing positions for ${market}`)

	const bothStrikesProvided = marketParams[market].callStrikes !== undefined && marketParams[market].putStrikes !== undefined
	const neitherStrikesProvided = marketParams[market].callStrikes === undefined && marketParams[market].putStrikes === undefined

	if (!neitherStrikesProvided || !bothStrikesProvided ){
		log.error(`Can only run ${market} with BOTH call/put strike arrays or NEITHER `)
		throw Error
	}

	// NOTE: may return undefined
	const curPrice = await getSpotPrice(market)
	const ts = moment.utc().unix()

	if (curPrice === undefined) {
		log.warning(
			`Skipping initialization for ${market}, spot price feed is not working`,
		)

		// IMPORTANT: if user gave BOTH strikes, we can getExistingPositions to withdraw; don't need hydrateStrikes()
		if (
			withdrawExistingPositions &&
			marketParams[market].callStrikes &&
			marketParams[market].putStrikes
		) {
			log.warning('Attempting to withdraw existing positions...')

			// IMPORTANT: can ONLY be run if BOTH call/put strikes exist in marketParams
			lpRangeOrders = await getExistingPositions(market)

			// IMPORTANT: can ONLY be run if BOTH call/put strikes exist in marketParams
			optionParams = await getUpdateOptionParams(
				optionParams,
				lpRangeOrders,
				market,
				curPrice,
				ts,
			)

			if (lpRangeOrders.length > 0) {
				lpRangeOrders = await withdrawSettleLiquidity(
					lpRangeOrders,
					market,
					optionParams,
				)
			}
		}

		return lpRangeOrders
	}

	marketParams[market].spotPrice = curPrice
	marketParams[market].ts = ts

	// NOTE: only run ONCE (initialization) to hydrate strikes in marketParams (if not provided)
	await hydrateStrikes(market, curPrice)

	// NOTE: only run ONCE (initialization) to hydrate range orders per market
	// IMPORTANT: can ONLY be run if strikes exist in marketParams
	lpRangeOrders = await getExistingPositions(market)

	// Initial hydration of option specs for each pool (K,T)
	// IMPORTANT: can ONLY be run if strikes exist in marketParams
	optionParams = await getUpdateOptionParams(
		optionParams,
		lpRangeOrders,
		market,
		curPrice,
		ts,
	)

	// Optional user config to start fresh
	// NOTE: if withdrawExistingPosition => withdrawable is false (will not process withdraw)
	if (lpRangeOrders.length > 0) {
		lpRangeOrders = await withdrawSettleLiquidity(
			lpRangeOrders,
			market,
			optionParams,
		)
	}

	// NOTE: all markets in optionsParams are deployed
	lpRangeOrders = await deployLiquidity(
		lpRangeOrders,
		market,
		curPrice,
		optionParams,
	)

	// initialization path complete
	initialized = true

	return lpRangeOrders
}

async function maintainPositions(lpRangeOrders: Position[], market: string) {
	log.app(`Running position maintenance process for ${market}`)

	const ts = moment.utc().unix() // seconds
	const curPrice = await getSpotPrice(market)

	if (curPrice === undefined) {
		log.warning(
			`Cannot get ${market} spot price, withdrawing range orders if any exist`,
		)
		// NOTE: curPrice undefined will set spotOracleFailure to true in optionParams
		optionParams = await getUpdateOptionParams(
			optionParams,
			lpRangeOrders,
			market,
			curPrice,
			ts,
		)
		lpRangeOrders = await withdrawSettleLiquidity(
			lpRangeOrders,
			market,
			optionParams,
		)
		return lpRangeOrders
	}

	log.info(
		`Updating spot price for ${market}: `,
		curPrice,
		moment.utc().format('YYYY-MM-HH:mm:ss'),
	)

	// All conditional thresholds that trigger an update
	const refPrice = marketParams[market].spotPrice!
	const abovePriceThresh = curPrice > refPrice * (1 + spotMoveThreshold)
	const belowPriceThresh = curPrice < refPrice * (1 - spotMoveThreshold)
	const pastTimeThresh =
		ts - timeThresholdHrs * 60 * 60 > marketParams[market].ts!

	// force update if a threshold is reached
	if (abovePriceThresh || belowPriceThresh || pastTimeThresh) {
		log.info('Threshold trigger reached. Checking for updates...')

		if (abovePriceThresh) log.info(`Above Price Threshold`)
		if (belowPriceThresh) log.info(`Below Price Threshold`)
		if (pastTimeThresh) log.info(`Time Threshold`)

		optionParams = await getUpdateOptionParams(
			optionParams,
			lpRangeOrders,
			market,
			curPrice,
			ts,
		)

		marketParams[market].spotPrice = curPrice
		marketParams[market].ts = ts

		// remove any liquidity if present
		lpRangeOrders = await withdrawSettleLiquidity(
			lpRangeOrders,
			market,
			optionParams,
		)

		// deploy liquidity in given market using marketParam settings
		lpRangeOrders = await deployLiquidity(
			lpRangeOrders,
			market,
			curPrice,
			optionParams,
		)
	} else {
		log.info(`No update triggered...`)
	}

	return lpRangeOrders
}

async function updateMarket(lpRangeOrders: Position[], market: string) {
	if (!initialized) {
		/*
			INITIALIZATION CASE: if we have no reference price established for a given market then this is the
			 initial run, so we must get price & ts and deploy all orders
		*/
		lpRangeOrders = await initializePositions(lpRangeOrders, market)
	} else {
		/*
			MAINTENANCE CASE: if we have a reference price we need to check it against current values and update
			markets accordingly
		*/

		lpRangeOrders = await maintainPositions(lpRangeOrders, market)
	}

	return lpRangeOrders
}

async function runRangeOrderBot() {
	log.app('Starting range order bot...')

	// Set ALL collateral approvals (base & quote) to max before first deposit cycle
	if (!initialized && maxCollateralApproved) {
		log.info(`Setting approvals for collateral tokens prior to deposits`)

		// Approvals for call base tokens
		for (const market of Object.keys(marketParams)) {
			const token = premia.contracts.getTokenContract(
				marketParams[market].address,
				premia.signer as any,
			)

			await setApproval(MaxUint256, token)

			log.info(`${market} approval set to MAX`)
		}

		// Approval for quote token (USDC only)
		const token = premia.contracts.getTokenContract(
			addresses.tokens.USDC,
			premia.signer as any,
		)

		await setApproval(MaxUint256, token)

		log.info(`USDC approval set to MAX`)
	}

	// iterate through each market to determine is liquidity needs to be deployed/updated
	for (const market of Object.keys(marketParams)) {
		lpRangeOrders = await updateMarket(lpRangeOrders, market)
	}
}

async function main() {
	while (true) {
		await runRangeOrderBot()

		log.app(
			'Completed, idling... View your active positions at https://app.premia.finance/pools',
		)

		await delay(refreshRate * 60 * 1000) // refresh rate from min -> milli sec
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})

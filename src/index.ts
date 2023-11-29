import moment from 'moment'
import { MaxUint256 } from 'ethers'

import {
	marketParams,
	spotMoveThreshold,
	refreshRate,
	timeThresholdHrs,
	maxCollateralApproved,
	withdrawOnly,
} from './config'
import { state } from './config/state'
import { log } from './utils/logs'
import { delay } from './utils/time'
import { getSpotPrice } from './utils/prices'
import { setApproval } from './actions/setApprovals'
import { getUpdateOptionParams } from './actions/getUpdateStatus'
import { withdrawSettleLiquidity } from './actions/withdrawPools'
import { hydrateStrikes } from './actions/hydrateStrikes'
import { getExistingPositions } from './actions/getPositions'
import { deployLiquidity } from './actions/hydratePools'

let initialized = false

async function initializePositions(market: string) {
	log.app(`Initializing positions for ${market}`)

	// NOTE: getSpotPrice may return undefined if the oracle calls fail
	const curPrice = await getSpotPrice(market)
	const ts = moment.utc().unix()

	if (curPrice === undefined) {
		log.warning(
			`Skipping initialization for ${market}, spot price feed is not working`,
		)

		const spotPriceEstimate = marketParams[market].spotPriceEstimate

		// IMPORTANT: attempts to hydrate strikes with spot price estimate, to be able to withdraw all positions
		if (spotPriceEstimate) {
			await hydrateStrikes(market, spotPriceEstimate)
		}

		// IMPORTANT: if BOTH call/put strikes exist in marketParams, we can getExistingPositions to withdraw
		if (marketParams[market].callStrikes && marketParams[market].putStrikes) {
			log.warning('Attempting to withdraw existing positions...')

			// IMPORTANT: can ONLY be run if BOTH call/put strikes exist in marketParams
			await getExistingPositions(market)

			// IMPORTANT: can ONLY be run if BOTH call/put strikes exist in marketParams
			// NOTE: we handle undefined spot price case in function
			await getUpdateOptionParams(market, curPrice, ts)

			if (state.lpRangeOrders.length > 0) {
				await withdrawSettleLiquidity(market)
			}
		}
		return
	}

	marketParams[market].spotPrice = curPrice
	marketParams[market].ts = ts

	// NOTE: only run ONCE (initialization) to hydrate strikes in marketParams (if not provided)
	// IMPORTANT: it can only run if we have a valid spot price
	await hydrateStrikes(market, curPrice)

	// NOTE: only run ONCE (initialization) to hydrate range orders per market
	// IMPORTANT: can ONLY be run if strikes exist in marketParams!
	await getExistingPositions(market)

	// Initial hydration of option specs for each pool (K,T)
	// IMPORTANT: can ONLY be run if strikes exist in marketParams!
	await getUpdateOptionParams(market, curPrice, ts)

	if (state.lpRangeOrders.length > 0) {
		await withdrawSettleLiquidity(market)
	}

	if (!withdrawOnly) {
		await deployLiquidity(market, curPrice)
	}
}

async function maintainPositions(market: string) {
	log.app(`Running position maintenance process for ${market}`)

	const ts = moment.utc().unix() // seconds
	const curPrice = await getSpotPrice(market)

	if (curPrice === undefined) {
		log.warning(
			`Cannot get ${market} spot price, withdrawing range orders if any exist`,
		)
		// NOTE: curPrice undefined will set spotOracleFailure to true in optionParams
		await getUpdateOptionParams(market, curPrice, ts)
		await withdrawSettleLiquidity(market)

		return
	}

	log.info(
		`Updating spot price for ${market}: `,
		curPrice,
		moment.utc().format('YYYY-MM-HH:mm:ss'),
	)

	await updateOnTrigger(market, curPrice, ts)
}

async function updateOnTrigger(market: string, curPrice: number, ts: number) {
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

		await getUpdateOptionParams(market, curPrice, ts)

		marketParams[market].spotPrice = curPrice
		marketParams[market].ts = ts

		// remove any liquidity if present
		await withdrawSettleLiquidity(market)

		// deploy liquidity in given market using marketParam settings
		await deployLiquidity(market, curPrice)
	} else {
		log.info(`No update triggered...`)
	}
}

async function updateMarket(market: string) {
	if (!initialized) {
		/*
			INITIALIZATION CASE: if we have no reference price established for a given market then this is the
			 initial run, so we must get price & ts and deploy all orders
		*/
		await initializePositions(market)
	} else {
		/*
			MAINTENANCE CASE: if we have a reference price we need to check it against current values and update
			markets accordingly
		*/

		await maintainPositions(market)
	}
}

async function runRangeOrderBot() {
	log.app('Starting range order bot...')

	if (withdrawOnly) {
		log.app('Withdraw only mode is enabled, running withdraw process...')

		// Set ALL collateral approvals (base & quote) to max before first deposit cycle
	} else if (!initialized && maxCollateralApproved) {
		log.info(`Setting approvals for collateral tokens prior to deposits`)

		// Approvals for call base tokens
		for (const market of Object.keys(marketParams)) {
			await setApproval(market, MaxUint256)
			log.info(`${market} approval set to MAX`)
		}

		// Approval for quote token (USDC only)
		await setApproval('USDC', MaxUint256)
		log.info(`USDC approval set to MAX`)
	}

	// iterate through each market to determine is liquidity needs to be deployed/updated
	// @dev: this cannot be parallelized because it would run into nonce issues
	for (const market of Object.keys(marketParams)) {
		await updateMarket(market)
	}

	// NOTE: after first run, initialized will remain true
	initialized = true
}

async function main() {
	while (true) {
		await runRangeOrderBot()

		if (withdrawOnly) {
			log.app(
				'Withdraw only mode is enabled, exiting after first cycle.. View your active positions at' +
					' https://app.premia.finance/pools',
			)

			break
		}

		log.app(
			'Cycle Completed, now idling until next refresh... View your active positions at' +
				' https://app.premia.finance/pools',
		)

		await delay(refreshRate * 60 * 1000) // refresh rate from min -> milli sec
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})

import moment from 'moment'
import { MaxUint256 } from 'ethers'
import { withdrawSettleLiquidity } from './actions/withdrawPools'
import {
	marketParams,
	spotMoveThreshold,
	refreshRate,
	timeThresholdMin,
	withdrawExistingPositions,
	maxCollateralApproved,
} from './config'
import { addresses } from './constants'
import { Position } from './types'
import { getExistingPositions } from './actions/getPositions'
import { deployLiquidity } from './actions/hydratePools'
import { premia } from './contracts'
import { log } from './utils/logs'
import { delay } from './utils/time'
import { getSpotPrice } from './utils/prices'
import { setApproval } from './utils/tokens'

let initialized = false
let lpRangeOrders: Position[] = []

async function initializePositions(lpRangeOrders: Position[], market: string) {
	log.app(`Initializing positions for ${market}`)

	// NOTE: getSpotPrice() returns undefined if multiple attempts fail
	const curPrice = await getSpotPrice(market)

	if (!curPrice) {
		log.warning(
			`Skipping initialization for ${market}, spot price feed is not working`,
		)
		return lpRangeOrders
	}

	// store latest price update
	marketParams[market].spotPrice = curPrice
	marketParams[market].ts = moment.utc().unix()

	lpRangeOrders = await getExistingPositions(market, curPrice)

	if (withdrawExistingPositions && lpRangeOrders.length > 0) {
		lpRangeOrders = await withdrawSettleLiquidity(lpRangeOrders, market)
	}

	lpRangeOrders = await deployLiquidity(lpRangeOrders, market, curPrice)

	return lpRangeOrders
}

async function maintainPositions(lpRangeOrders: Position[], market: string) {
	log.app(`Running position maintenance process for ${market}`)

	const ts = moment.utc().unix() // seconds

	const curPrice = await getSpotPrice(market)

	if (!curPrice) {
		log.warning(
			`Skipping update cycle for ${market}, spot price feed is not working`,
		)
		// TODO: it would make sense to pull quotes if there is a chronic price feed failure
		return lpRangeOrders
	}

	log.info(
		'Updated spot price: ',
		curPrice,
		moment.utc().format('YYYY-MM-HH:mm:ss'),
	)

	/*
	NOTE: It costs ~ $1 total to do a deposit and withdraw (round turn).  We need to optimize
	which range orders we are updating to avoid unnecessary costs.
	 */
	// TODO: use theta decay instead of fixed frequency
	// TODO: use delta as a threshold

	// All conditional thresholds that trigger an update
	const refPrice = marketParams[market].spotPrice!
	const abovePriceThresh = curPrice > refPrice * (1 + spotMoveThreshold)
	const belowPriceThresh = curPrice < refPrice * (1 - spotMoveThreshold)
	const pastTimeThresh = ts - timeThresholdMin * 60 > marketParams[market].ts!

	// force update if a threshold is reached
	if (abovePriceThresh || belowPriceThresh || pastTimeThresh) {
		log.info('Threshold trigger reached. Updating orders...')

		if (abovePriceThresh) log.info(`Above Price Threshold`)
		if (belowPriceThresh) log.info(`Below Price Threshold`)
		if (pastTimeThresh) log.info(`Time Threshold`)

		// update ref price & ts to latest value
		marketParams[market].spotPrice = curPrice
		marketParams[market].ts = ts

		// remove any liquidity if present
		lpRangeOrders = await withdrawSettleLiquidity(lpRangeOrders, market)

		// deploy liquidity in given market using marketParam settings
		lpRangeOrders = await deployLiquidity(
			lpRangeOrders,
			market,
			marketParams[market].spotPrice!,
		)
	} else {
		log.info(`No update triggered...`)
	}

	return lpRangeOrders
}

async function updateMarket(lpRangeOrders: Position[], market: string) {
	if (!marketParams[market].spotPrice) {
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

	if (!initialized) {
		// Set ALL collateral approvals (base & quote) to max before first deposit cycle
		if (maxCollateralApproved) {
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
		initialized = true
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

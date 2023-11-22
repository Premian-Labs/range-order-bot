/*
	NOTE: Trade related settings may need to be tweaked from time to time depending on risk,
	market conditions, and changes in available strikes/expirations
 */
import { MarketParams, State } from '../utils/types'
import { addresses } from './constants'
import { LogLevel } from '../utils/logs'

// IMPORTANT: DO NOT TOUCH  (will hydrate while bot is running)
export const state: State = {
	lpRangeOrders: [],
	optionParams: [],
}

/*
	Log levels can be set to one of the following levels: DEBUG | INFO | WARN | ERROR.  Each level is inclusive
	of the next levels.  For example, if you set to INFO, you will also receive INFO, WARN, & ERROR logs.
 */
export const logLevel: LogLevel = 'INFO'

/*
	These are the designated markets in which to provide liquidity for. Please note that it is
	possible some markets listed here might not trade if certain thresholds set by the user are breached.
	All these settings/thresholds can be found below marketParam configuration.

	markets (required): There MUST be an IV oracle/surface for each market.  Please see the README for available
	markets. Any markets that is not intended to be traded should be completely removed from marketParams.

	address (required): Using addresses.tokens.{INSERT TOKEN SYMBOL} will add the token address for the given market. If
	the market is not available, it will not populate.  Please see the README for available markets.

	spotPriceEstimate (optional): This is the spot price estimate for the given market.  Required for the bot to withdraw
	positions if the bot fails to fetch a spot price for a market.  This is NOT the oracle price, but rather a spot price
	estimate used for withdrawing positions.  This is NOT required if the bot is deployed in a market that has a working spot
	price oracle.

	maturities (required): All expirations to trade.  Invalid dates will be rejects and throw warnings while bot is
	running.  Any options that have expired or expire while the bot is running will automatically exercise/settle positions.

	strikes (optional): a user can input specific strikes that they would like to trade.  Optionally, if they would like
	to trade all applicable strikes (within a delta range), BOTH callSTrikes and putStrikes can be COMPLETELY removed.
	In this case the bot will depend on the min/max delta range as the limiting factors and the bot will trade
	everything inbetween.

	depositSize (required): this is based on the number of option contracts your range order could possibly trade if
	traversed fully. This should be smaller than maxExposure.  Note that collateral requirements are different for long
	option positions vs short option positions.

	maxExposure (required): max exposure applies to EITHER long or short exposure limits (contracts) when an exposure (long
	or short) is greater than or equal to this value. It will then enter into "close only" mode where it posts only one
	range order using the existing positions in an attempt to close them. Limits apply for EACH option (K,T) individually,
	not collectively.

	minOptionPrice (required): This is the minimum price of an option in which we will still quote two-sided markets.
	If price is lower, we will only quote a RIGHT SIDE order. A price lower than 0.004 may cause deposit errors due to
	valid range width collision.
	IMPORTANT: This is NORMALIZED PRICE. Calls are price in underlying and puts
	are priced in USDC but based on the strike price. For example, a 1500 strike
	put at 0.004 is (0.004 * 1500) in USDC terms.
 */

// TODO FEATURE: enable Put only or Call only trading
// TODO FEATURE: enable one-sided trading only (ie. left or right side)
export const marketParams: MarketParams = {
	WETH: {
		address: addresses.tokens.WETH,
		maturities: ['08DEC23', '15DEC23'],
		spotPriceEstimate: 2000,
		callStrikes: [2000],
		putStrikes: [1900],
		depositSize: 1,
		maxExposure: 2,
		minOptionPrice: 0.003,
	},
	WBTC: {
		address: addresses.tokens.WBTC,
		maturities: ['08DEC23', '15DEC23'],
		spotPriceEstimate: 36000,
		callStrikes: [35000],
		putStrikes: [35000],
		depositSize: 0.05,
		maxExposure: 0.1,
		minOptionPrice: 0.003,
	},
}

/*
	If an option markets delta goes outside the min/max range it will automatically be excluded from
	new liquidity deployment (this overrides the markets set in marketParams)
 */
export const minDelta = 0.1 // .15 recommended
export const maxDelta = 0.9 // .6 recommended

/*
	If an option market falls below this threshold, it will automatically be excluded from new
	liquidity deployment (this overrides the markets set in marketParams)
 */
export const minDTE = 2 // 2 days recommended

/*
	Approvals for transactions are done on a "per deposit" basis by default.  This could be costly over time
	but gives additional security features.  Optionally, you can set the approvals for all collateral types
	ahead of time (set to max uint256) to avoid approvals on each deposit.

	WARNING: This script does NOT remove max approval
 */
export const maxCollateralApproved = true

/*
  NOTE: this will determine the width of the range order
  If the value is < 50% this may generate errors when trying
  to determine the proper width of a range order for an option
  that have a very small fair value.
  TIP: If set < 50% it may be best to increase minDelta.
 */
export const rangeWidthMultiplier = 0.6 //60%

/*
	This spread will be added/subtracted from the option fair value
	before attempting to find a valid range order.
 */
export const defaultSpread = 0.1 //10%

/*
	This is the amount of spot price movement since the last range order update that will force a new
	update of range orders.  It is percentage based and formatted as a decimal (ie 0.01 -> 1%)
 */
export const spotMoveThreshold = 0.01 // 1%

/*
	This is the amount of time in minutes that the spot price & ts for a given market is checked to see
	if price or ts has exceeded thresholds to force updates to lp range orders
	NOTE: this should be smaller than timeThresholdHrs (which should be divisible by refreshRate)
	optimal range is likely between 5 min <-> 60 min
 */
export const refreshRate = 5 //minutes

/*
	The max number of hours LP range orders will sit out in the market without being updated. This will
	happen when spot fails to exceed the spotMoveThreshold, but we still need to update orders to compensate
	for time decay.

	NOTE: optimal range is likely 1 <-> 24 hrs
 */
export const timeThresholdHrs = 6 // float expressed in hours

/*
	If any positions accrue on both the long/short token of an option, the script will annihilate
	the exposure to release collateral automatically prior to each lp deposit.  In order to avoid
	dust annihilation, a min value to annihilate is set to avoid unnecessary transactions. The value
	is represented in standard value (and converted to 18 decimal places automatically).
 */
export const minAnnihilationSize = 0.05

/*
	NOTE:  If set to true, pool will be deployed if not available.
	deployment fees will be paid if set to TRUE
	If false, the market will be skipped
 */
export const autoDeploy = true

/*
	If autoDeploy is set to true, it is possible that this script will deploy
	a pool if it is not available. If so, we can set the (max) fee associated with
	deployment here.  Any excess is returned back. Value is in ETH.
 */
// TODO: no longer needed
export const maxDeploymentFee = '0.05'

/*
	This is the risk-free rate used in determining the option value via bsm.
	The value is a percentage represented in decimal form (type: number)
 */
export const riskFreeRate = 0.05

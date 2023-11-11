/*
NOTE: Trade related settings may need to be tweaked from time to time depending on risk,
market conditions, and changes in available strikes/expirations
 */
import { MarketParams } from './types'
import { addresses, productionTokenAddr } from './constants'
import { LogLevel } from './utils/logs'

/*
These are the designates markets in which to provide liquidity for. Please note that it is
possible some markets will not trade if certain settings/thresholds are breached.  All
settings/thresholds can be found below marketParam configuration.

NOTE: max exposure applies to EITHER long or short exposure limits. It will override one side
of range orders and by bid-only or ask-only if a position limit is hit. The limit is for EACH
option (K,T) individually, not collectively.

PREREQUISITE: there MUST be an IV oracle/surface for each market

 */

// Set to one of the following to enable/disable logs: DEBUG | INFO | WARN | ERROR
export const logLevel: LogLevel = 'INFO'

export const marketParams: MarketParams = {
	WETH: {
		address: addresses.tokens.WETH,
		maturities: ['17NOV23', '24NOV23'],
		// callStrikes: [/*1500,*/ 1600, 1700, 1800 /*, 1900*/],
		// putStrikes: [/*1200, 1300, */ 1400, 1500, 1600],
		depositSize: 1,
		maxExposure: 2,
	},
	WBTC: {
		address: addresses.tokens.WBTC,
		maturities: ['17NOV23', '24NOV23'],
		callStrikes: [35000, 36000],
		putStrikes: [34000, 35000],
		depositSize: 0.05,
		maxExposure: 0.1,
	},
	ARB: {
		address: (addresses.tokens as typeof productionTokenAddr).ARB,
		maturities: ['17NOV23', '24NOV23'],
		// callStrikes: [/*0.8,*/ 0.9, 1, 1.1 /*1.2*/],
		// putStrikes: [/*0.5, 0.6, */ 0.7, 0.8, 0.9],
		depositSize: 2500,
		maxExposure: 5000,
	},

	MAGIC: {
		address: (addresses.tokens as typeof productionTokenAddr).MAGIC,
		maturities: ['17NOV23', '24NOV23', '01DEC23', '08DEC23'],
		depositSize: 100,
		maxExposure: 1000,
	},

	GMX: {
		address: (addresses.tokens as typeof productionTokenAddr).GMX,
		maturities: ['17NOV23', '24NOV23', '01DEC23', '08DEC23'],
		depositSize: 10,
		maxExposure: 100,
	},

	LINK: {
		address: (addresses.tokens as typeof productionTokenAddr).LINK,
		maturities: ['17NOV23', '24NOV23', '01DEC23', '08DEC23'],
		depositSize: 10,
		maxExposure: 100,
	},
}

/*
If an option markets delta goes outside the min/max range it will automatically be excluded from
new liquidity deployment (this overrides the markets set in marketParams)
 */
export const minDelta = 0.01 // .15 recommended
export const maxDelta = 0.99 // .6 recommended

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
This is the minimum price of an option in which we will still quote
two-sided markets.  If price is lower, we will only quote a RIGHT SIDE
order.
NOTE: A price lower than 0.004 may cause deposit errors due to valid range
width collision.
IMPORTANT: This is NORMALIZED PRICE. Calls are price in underlying and puts
are priced in USDC but based on the strike price. For example, a 1500 strike
put at 0.004 is (0.004 * 1500) in USDC terms.
 */
export const minOptionPrice = 0.003

/*
This is the amount of spot price movement since the last range order update that will force a new
update of range orders.  It is percentage based and formatted as a decimal (ie 0.01 -> 1%)
 */
export const spotMoveThreshold = 0.025 // 1%

/*
This is the amount of time in minutes that the spot price & ts for a given market is checked to see
if price or ts has exceeded thresholds to force updates to lp range orders
NOTE: this should be smaller than timeThresholdMin (which should be divisible by refreshRate)
optimal range is likely between 5 min <-> 60 min
 */
export const refreshRate = 5 //minutes

/*
The max number of minutes LP range orders will sit out in the market without being updated. This will
happen when spot fails to exceed the spotMoveThreshold, but we still need to update orders to compensate
for time decay.
NOTE: optimal range is likely 360 <-> 1440 min (6 <-> 24 hrs)
 */
export const timeThresholdMin = 720 // expressed in minutes

/*
If set to true, when the bot initialized it will search for existing LP range orders
for each market that is listed in marketParams and withdraw from those positions prior
to establishing new range orders.
 */
export const withdrawExistingPositions = true

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
export const maxDeploymentFee = '0.05'

/*
This is the risk-free rate used in determining the option value via bsm.
The value is a percentage represented in decimal form (type: number)
 */
export const riskFreeRate = 0.05

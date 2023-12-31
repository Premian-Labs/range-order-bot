import { formatUnits, formatEther, parseEther } from 'ethers'
import { PoolKey, TokenType } from '@premia/v3-sdk'

import { marketParams } from '../config'
import { addresses, lpAddress } from '../config/constants'
import { botMultiCallProvider, poolFactory, premia } from '../config/contracts'
import { state } from '../config/state'
import { log } from '../utils/logs'
import { createExpiration } from '../utils/dates'
import { MarketSummary, OptionBalances, RangeOrderStats } from '../utils/types'

export async function logPortfolioSummary() {
	// RESET PORTFOLIO SUMMARY
	state.portfolioSummary = {}

	let collateralTokens: string[] = []
	for (const market of Object.keys(marketParams)) {
		// Add market if the call strikes are being traded
		if (marketParams[market].callStrikes!.length > 0) {
			collateralTokens.push(market)
		}
		// Add USDC if any market trades puts (filter for dupe)
		if (
			marketParams[market].putStrikes!.length > 0 &&
			!collateralTokens.includes('USDC')
		) {
			collateralTokens.push('USDC')
		}
	}

	// Move USDC to the end
	if (collateralTokens.includes('USDC'))
		collateralTokens.push(
			collateralTokens.splice(collateralTokens.indexOf('USDC'), 1)[0],
		)

	// Initialize Portfolio Summary with Collateral Tokens
	for (const collateralToken of collateralTokens)
		state.portfolioSummary[collateralToken] = {} as MarketSummary

	// COLLATERAL SUMMARY
	await getCollateralBalances(collateralTokens)

	// OPTION BALANCE SUMMARY
	await getOptionPositions(collateralTokens)

	// LP RANGE ORDER SUMMARY
	await getRangeOrdersStats(collateralTokens)

	console.log(`\n`)
	// NOTE: deliberate console.log to change terminal color to default
	console.log(`\x1b[39m Portfolio Summary: \n`)
	for (const collateralToken in state.portfolioSummary) {
		console.group(collateralToken)
		console.log(state.portfolioSummary[collateralToken])
		console.groupEnd()
	}
	console.log(`\n`)
}

async function getCollateralBalances(collateralTokens: string[]) {
	for (const market of collateralTokens) {
		const token = premia.contracts.getTokenContract(
			market === 'USDC' ? addresses.tokens.USDC : marketParams[market].address!, //set in getAddresses(),
			botMultiCallProvider,
		)

		const [decimals, collateralValue] = await Promise.all([
			Number(await token.decimals()),
			token.balanceOf(lpAddress),
		])
		// add balances to global summary
		state.portfolioSummary[market].tokenBalance = Number(
			parseFloat(formatUnits(collateralValue, decimals)).toFixed(4),
		)
	}
}

async function getOptionPositions(collateralTokens: string[]) {
	//Filter option by Market & Option Type (by collateral)
	for (const market of collateralTokens) {
		// Initialize optionBalance key
		state.portfolioSummary[market].optionPositions = {} as OptionBalances

		const isCall = market !== 'USDC'
		const filteredOptionParams = state.optionParams.filter((option) => {
			return isCall
				? option.market === market && option.isCall === isCall
				: option.isCall === isCall
		})

		for (const op of filteredOptionParams) {
			// NOTE: no try catch (no reason it should fail). already been checked for validity
			const maturityTimestamp = createExpiration(op.maturity)
			const poolKey: PoolKey = {
				base: marketParams[op.market].address!, //set in getAddresses()
				quote: addresses.tokens.USDC,
				oracleAdapter: addresses.core.ChainlinkAdapterProxy.address,
				strike: parseEther(op.strike.toString()),
				maturity: maturityTimestamp,
				isCallPool: op.isCall,
			}
			let poolAddress: string
			let isDeployed: boolean
			try {
				//NOTE: poolFactory instance does not use a multicall provider
				;[poolAddress, isDeployed] = await poolFactory.getPoolAddress(poolKey)
			} catch (e) {
				log.warning(
					`Could not get pool address for ${market}-${op.maturity}-${
						op.strike
					}-${op.isCall ? 'C' : 'P'}`,
				)
				continue
			}

			if (isDeployed) {
				const multicallPool = premia.contracts.getPoolContract(
					poolAddress,
					botMultiCallProvider,
				)

				log.debug(
					`Getting Balances for: ${market}-${op.maturity}-${op.strike}-${
						op.isCall ? 'C' : 'P'
					}`,
				)

				let longBalance: number
				let shortBalance: number
				try {
					;[longBalance, shortBalance] = await Promise.all([
						parseFloat(
							formatEther(
								await multicallPool.balanceOf(lpAddress!, TokenType.LONG),
							),
						),
						parseFloat(
							formatEther(
								await multicallPool.balanceOf(lpAddress!, TokenType.SHORT),
							),
						),
					])
				} catch (err) {
					log.warning(
						`Could not query balances for ${market}-${op.maturity}-${
							op.strike
						}-${op.isCall ? 'C' : 'P'}`,
					)
					continue
				}

				// log net exposure for each option market
				state.portfolioSummary[market].optionPositions[
					`${op.market}-${op.maturity}-${op.strike}-${op.isCall ? 'C' : 'P'}:`
				] = Number((longBalance - shortBalance).toFixed(4))
			}
		}
	}
}

async function getRangeOrdersStats(collateralTokens: string[]) {
	for (const market of collateralTokens) {
		// Initialize rangeOrderStats key
		state.portfolioSummary[market].rangeOrderStats = {} as RangeOrderStats

		const isCall = market !== 'USDC'
		const filteredRangeOrders = state.lpRangeOrders.filter((lpRangeOrder) => {
			return isCall
				? lpRangeOrder.market === market && lpRangeOrder.isCall === isCall
				: lpRangeOrder.isCall === isCall
		})

		// Number of range orders for collateral type
		state.portfolioSummary[market].rangeOrderStats.activeRangeOrders =
			filteredRangeOrders.length

		// Number of range orders using tokens as collateral
		const tokenBasedRangeOrders = filteredRangeOrders.filter(
			(rangeOrder) => rangeOrder.isCollateral,
		)
		state.portfolioSummary[market].rangeOrderStats.tokenBasedRangeOrders =
			tokenBasedRangeOrders.length
		state.portfolioSummary[market].rangeOrderStats.optionBasedRangeOrders =
			filteredRangeOrders.length - tokenBasedRangeOrders.length

		/*
 			CheatSheet for Range Orders:
			lc => 2  cs => 1
			NOTE: isCollateral & orderType:2 => leftSide Order w/ collateral
			NOTE: isCollateral & orderType:1 => rightSide Order w/ collateral
			NOTE: !isCollateral & orderType:2 => rightSide w/ long options
			NOTE: !isCollateral & orderType:1 => leftSide w/ short options
 		*/

		//Amount of tokens committed to range orders
		let totalTokensUsed = 0
		for (const tokenBasedRangeOrder of tokenBasedRangeOrders) {
			let orderType = tokenBasedRangeOrder.posKey.orderType
			let depositSize = tokenBasedRangeOrder.depositSize
			let lowerTick = parseFloat(tokenBasedRangeOrder.posKey.lower)
			let upperTick = parseFloat(tokenBasedRangeOrder.posKey.upper)
			let isCall = tokenBasedRangeOrder.isCall
			let strike = tokenBasedRangeOrder.strike

			// NOTE: leftSide order (lc) with collateral
			if (orderType === 2) {
				totalTokensUsed += isCall
					? (depositSize * (upperTick + lowerTick)) / 2
					: ((depositSize * (upperTick + lowerTick)) / 2) * strike
			} else {
				// NOTE: rightSide order (cs) with collateral
				totalTokensUsed += isCall ? depositSize : depositSize * strike
			}
		}

		state.portfolioSummary[market].rangeOrderStats.totalCollateralUsed = Number(
			totalTokensUsed.toFixed(4),
		)
	}
}

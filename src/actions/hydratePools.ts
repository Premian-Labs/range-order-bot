import { PosKey, Position, MarketParams } from '../types'
import { formatEther, parseEther, formatUnits } from 'ethers'
import { lpAddress, addresses } from '../constants'
import {
	autoDeploy,
	defaultSpread,
	maxCollateralApproved,
	maxDeploymentFee,
	minAnnihilationSize,
	minDTE,
	minOptionPrice,
	rangeWidthMultiplier,
} from '../config'
import { IPool, OrderType, PoolKey, TokenType } from '@premia/v3-sdk'
import { createExpiration, getDaysToExpiration, getTTM } from '../utils/dates'
import { setApproval } from '../utils/tokens'
import { premia, provider, signerAddress, poolFactory } from '../contracts'
import { getValidStrikes } from '../utils/strikes'
import {
	getCollateralApprovalAmount,
	getValidRangeWidth,
} from '../utils/rangeOrders'
import { marketParams } from '../config'
import { log } from '../utils/logs'

export async function deployLiquidity(
	lpRangeOrders: Position[],
	market: string,
	spotPrice: number,
) {
	log.app(`Deploying liquidity for ${market}`)

	try {
		/// @dev: no point parallelizing this since we need to wait for each tx to confirm
		///		  with a better nonce manager, this would not be necessary since withdrawals
		///		  are independent of each other
		for (const maturityString of marketParams[market].maturities) {
			log.info(`Spot Price for ${market}: ${spotPrice}`)

			lpRangeOrders = await processStrikes(
				market,
				spotPrice,
				marketParams,
				maturityString,
				true,
				lpRangeOrders,
			)

			lpRangeOrders = await processStrikes(
				market,
				spotPrice,
				marketParams,
				maturityString,
				false,
				lpRangeOrders,
			)
		}
	} catch (e) {
		log.error(`Error deploying liquidity: ${e}`)
		log.error(`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`)
		return lpRangeOrders
	}

	log.info(`All Positions Successfully Processed for ${market}!`)
	log.info(`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`)

	return lpRangeOrders
}

export async function processStrikes(
	market: string,
	spotPrice: number,
	marketParams: MarketParams,
	maturityString: string,
	isCall: boolean,
	lpRangeOrders: Position[],
) {
	// format exp 15SEP23 => 1234567891
	const maturityTimestamp = createExpiration(maturityString)
	const daysToExpiration = getDaysToExpiration(maturityString)

	log.debug(`Maturity TS: ${maturityTimestamp} (${daysToExpiration} DTE)`)

	// 1.1 check if option already expired
	if (daysToExpiration <= 0) {
		log.warning(`Skipping expiration date: ${maturityString} is in the past`)
		return lpRangeOrders
	}

	// 1.2 check if option expiration is more than 1 year out
	if (daysToExpiration > 365) {
		log.warning(
			`Skipping expiration date: ${maturityString} is more then in 1 year`,
		)
		return lpRangeOrders
	}

	const strikes = await getValidStrikes(
		market,
		spotPrice,
		marketParams,
		maturityString,
		isCall,
	)

	/// @dev: no point parallelizing this since we need to wait for each tx to confirm
	///		  with a better nonce manager, this would not be necessary since withdrawals
	///		  are independent of each other
	for (const { strike, option } of strikes) {
		log.info(
			`Working on ${market} ${isCall ? 'Calls' : 'Puts'} for ${maturityString}`,
		)

		const poolKey: PoolKey = {
			base: marketParams[market].address,
			quote: addresses.tokens.USDC,
			oracleAdapter: addresses.core.ChainlinkAdapterProxy.address,
			strike: parseEther(strike.toString()),
			maturity: maturityTimestamp,
			isCallPool: isCall,
		}

		log.debug(`${isCall ? 'Call' : 'Put'} PoolKey:`, poolKey)

		const [poolAddress, isDeployed] = await poolFactory.getPoolAddress(poolKey)

		log.debug(`${isCall ? 'Call' : 'Put'} poolAddress: ${poolAddress}`)

		const found = lpRangeOrders.find((position) => {
			if (position.poolAddress === poolAddress && position.isCall === isCall) {
				return true
			}

			return false
		})

		if (found) {
			log.warning(
				`Skipping ${market} ${maturityString} ${formatEther(strike)} ${
					isCall ? 'Calls' : 'Puts'
				}. Already Deposited`,
			)
			continue
		}

		if (!isDeployed && !autoDeploy) {
			log.warning(
				`Skipping ${market} ${maturityString} ${formatEther(strike)} ${
					isCall ? 'Calls' : 'Puts'
				}. No Pool Exists `,
			)
			continue
		}

		const ttm = getTTM(maturityTimestamp)

		if (ttm * 365 < minDTE) {
			log.warning(
				`Skipping ${market} ${maturityString} ${isCall ? 'Calls' : 'Puts'}`,
			)
			log.warning(`Option under min DTE. DTE: ${ttm * 365}`)
			continue
		}

		if (!isDeployed && autoDeploy) {
			log.info(`Pool does not exist. Deploying pool now....`)

			const deploymentTx = await poolFactory.deployPool(poolKey, {
				value: parseEther(maxDeploymentFee), // init fee excess refunded
				// gasLimit: 10000000, // fails to properly estimate gas limit
			})

			const confirm = await provider.waitForTransaction(deploymentTx.hash, 1)

			if (confirm?.status == 0) {
				log.warning(
					`Pool was not deployed, skipping ${market} ${maturityString} ${
						isCall ? 'Calls' : 'Puts'
					}`,
				)
				log.warning(confirm)
				continue
			}

			log.info(
				`${market} ${strike} ${maturityString} ${
					isCall ? 'Call' : 'Put'
				} pool deployment confirmed!`,
			)
		}

		const pool = premia.contracts.getPoolContract(
			poolAddress,
			premia.multicallProvider as any,
		)

		let [marketPrice, longBalance, shortBalance] = await Promise.all([
			parseFloat(formatEther(await pool.marketPrice())),

			// check to see if we have positions that can be annihilated
			parseFloat(formatEther(await pool.balanceOf(lpAddress!, TokenType.LONG))),
			parseFloat(
				formatEther(await pool.balanceOf(lpAddress!, TokenType.SHORT)),
			),
		])

		log.debug(`${isCall ? 'Call' : 'Put'} MarketPrice: ${marketPrice}`)

		// Option price normalized
		const optionPrice = option.price / spotPrice

		log.debug(`${isCall ? 'Call' : 'Put'} Fair Value: ${optionPrice}`)

		// Create a new provider with signer to execute transactions
		const executablePool = premia.contracts.getPoolContract(
			poolAddress,
			premia.signer as any,
		)

		// annihilation process (preprocess before deposits)
		if (
			shortBalance > minAnnihilationSize &&
			longBalance > minAnnihilationSize
		) {
			const annihilationSize = Math.min(longBalance, shortBalance)
			const annihilationSizeBigInt = parseEther(annihilationSize.toString())

			log.info(`Annihilating ${annihilationSize} contracts..`)

			const annihilateTx = await executablePool.annihilate(
				annihilationSizeBigInt,
				{
					gasLimit: 1400000,
				},
			)
			const confirm = await provider.waitForTransaction(annihilateTx.hash, 1)

			if (confirm?.status == 0) {
				log.warning('Failed to annihilate existing positions.')
			} else {
				// Update balances post annihilation
				;[longBalance, shortBalance] = await Promise.all([
					parseFloat(
						formatEther(await pool.balanceOf(lpAddress!, TokenType.LONG)),
					),
					parseFloat(
						formatEther(await pool.balanceOf(lpAddress!, TokenType.LONG)),
					),
				])
			}
		}

		/*
		=========================================================================================
		================================RIGHT SIDE SETUP=========================================
		=========================================================================================

			NOTE: for RIGHT SIDE orders if market price > option price than we use market price due
			to issues with crossing markets with range orders (which cause the range order to fail)
 		*/

		const rightRefPrice = marketPrice > optionPrice ? marketPrice : optionPrice
		const marketPriceUpper =
			Math.ceil((rightRefPrice * (1 + defaultSpread) + 0.001) * 1000) / 1000
		const targetUpperTick = Math.min(
			1,
			Math.ceil(marketPriceUpper * (1 + rangeWidthMultiplier) * 1000) / 1000,
		)

		log.debug(
			`${isCall ? 'Call' : 'Put'} marketPriceUpper: ${marketPriceUpper}`,
		)
		log.debug(`${isCall ? 'Call' : 'Put'} targetUpper: ${targetUpperTick}`)

		const [lowerTickCS, upperTickCS] = getValidRangeWidth(
			marketPriceUpper,
			targetUpperTick,
			'RIGHT',
		)

		log.info(
			`Final RIGHT SIDE Order-> Lower: ${lowerTickCS} and Upper: ${upperTickCS}`,
		)

		// if we have enough long positions for a right side order, use it instead
		const rightOrderType =
			longBalance > marketParams[market].depositSize
				? OrderType.LONG_COLLATERAL
				: OrderType.COLLATERAL_SHORT

		const rightPosKey: PosKey = {
			owner: signerAddress,
			operator: signerAddress,
			lower: parseEther(lowerTickCS.toString()),
			upper: parseEther(upperTickCS.toString()),
			orderType: rightOrderType,
		}

		// NOTE: if using options for a RIGHT side order, collateral amount is ZERO
		const rightSideCollateralAmount = await getCollateralApprovalAmount(
			market,
			rightPosKey,
			false,
			isCall,
			marketParams[market].depositSize,
			strike,
		)

		/*
		=========================================================================================
		=================================LEFT SIDE SETUP=========================================
		=========================================================================================

			NOTE: for LEFT SIDE orders if market price < option price than we use market price due
			to issues with crossing markets with range orders (which cause the range order to fail)
 		*/

		// set default values in case we violate minOptionPrice and skip section
		const leftRefPrice = marketPrice < optionPrice ? marketPrice : optionPrice

		let leftSideCollateralAmount = 0
		let leftPosKey: PosKey | undefined

		// If price is too low, we want to skip this section (we will not post LEFT side order)
		if (leftRefPrice > minOptionPrice) {
			const marketPriceLower =
				Math.floor((leftRefPrice * (1 - defaultSpread) - 0.001) * 1000) / 1000
			const targetLowerTick =
				Math.ceil(marketPriceLower * (1 - rangeWidthMultiplier) * 1000) / 1000

			log.debug(
				`${isCall ? 'Call' : 'Put'} marketPriceLower: ${marketPriceLower}`,
			)
			log.debug(`${isCall ? 'Call' : 'Put'} targetLower: ${targetLowerTick}`)

			const [lowerTickLC, upperTickLC] = getValidRangeWidth(
				targetLowerTick,
				marketPriceLower,
				'LEFT',
			)

			log.info(
				`Final LEFT SIDE Order-> Lower: ${lowerTickLC} and Upper: ${upperTickLC}`,
			)

			// if we have enough short positions, use it instead
			const leftOrderType =
				shortBalance > marketParams[market].depositSize
					? OrderType.COLLATERAL_SHORT
					: OrderType.LONG_COLLATERAL

			leftPosKey = {
				owner: signerAddress,
				operator: signerAddress,
				lower: parseEther(lowerTickLC.toString()),
				upper: parseEther(upperTickLC.toString()),
				orderType: leftOrderType,
			}

			// NOTE: if using options for a LEFT side order, collateral amt is ZERO
			leftSideCollateralAmount = await getCollateralApprovalAmount(
				market,
				leftPosKey,
				true,
				isCall,
				marketParams[market].depositSize,
				strike,
			)
		} else {
			// If price of option is too low, we do NOT want to place an LEFT side range order
			// NOTE: we do not process a trade if price is equal to minOptionPrice
			log.warning(
				`Option price too low. No LEFT SIDE order generated for ${market} ${strike} ${maturityString} ${
					isCall ? 'Calls' : 'Puts'
				}`,
			)
		}

		/*
		=========================================================================================
		==================================PROCESS DEPOSITS=======================================
		=========================================================================================

		NOTE: once the deposits are queued up, we need to do quality control checks to make sure that
		we are not breaching any limits (ie max exposure or low account collateral balance)
		*/

		// collateral address (for both LEFT & RIGHT side orders)
		const collateralTokenAddr = isCall
			? marketParams[market].address
			: addresses.tokens.USDC

		const token = premia.contracts.getTokenContract(
			collateralTokenAddr,
			premia.multicallProvider as any,
		)
		const [decimals, collateralValue] = await Promise.all([
			Number(await token.decimals()),
			token.balanceOf(lpAddress!),
		])
		const collateralBalance = parseFloat(formatUnits(collateralValue, decimals))

		log.info(
			`Collateral token balance: ${collateralBalance} ${
				isCall ? market : 'USDC'
			}`,
		)

		// determine deposit capabilities
		const sufficientCollateral =
			collateralBalance >= rightSideCollateralAmount + leftSideCollateralAmount
		const rightSideUsesOptions = rightSideCollateralAmount == 0
		const leftSideUsesOptions = leftSideCollateralAmount == 0

		// NOTE: we will still post single sided markets with options (close only quoting)
		// If both orders require collateral and there is not enough for either: skip BOTH deposits
		if (
			!sufficientCollateral &&
			leftSideCollateralAmount > 0 &&
			rightSideCollateralAmount > 0
		) {
			log.warning(
				`INSUFFICIENT COLLATERAL BALANCE. No collateral based range deposits made for 
				${market} 
				${maturityString} 
				${strike} 
				${isCall ? 'Call' : 'Put'}`,
			)
			continue
		}

		// check to see if we have breached our position limit for RIGHT SIDE orders
		if (shortBalance >= marketParams[market].maxExposure) {
			log.warning('Max SHORT exposure reached, no RIGHT SIDE order placed..')
			// if we are posting options only or have sufficient collateral do deposit: process
		} else if (rightSideUsesOptions || sufficientCollateral) {
			// RIGHT SIDE ORDER
			lpRangeOrders = await depositRangeOrderLiq(
				market,
				pool,
				executablePool,
				poolAddress,
				strike,
				maturityString,
				rightPosKey,
				false,
				marketParams[market].depositSize,
				collateralTokenAddr,
				rightSideCollateralAmount,
				isCall,
				lpRangeOrders,
			)
		}

		// check to see if we have breached our position limit for RIGHT SIDE orders
		if (longBalance >= marketParams[market].maxExposure) {
			log.warning('Max LONG exposure reached, no LEFT SIDE order placed..')
			// if we are posting options only or have sufficient collateral do deposit: process
		} else if (leftPosKey && (leftSideUsesOptions || sufficientCollateral)) {
			// LEFT SIDE ORDER
			lpRangeOrders = await depositRangeOrderLiq(
				market,
				pool,
				executablePool,
				poolAddress,
				strike,
				maturityString,
				leftPosKey,
				true,
				marketParams[market].depositSize,
				collateralTokenAddr,
				leftSideCollateralAmount,
				isCall,
				lpRangeOrders,
			)
		}
	}

	return lpRangeOrders
}

async function depositRangeOrderLiq(
	market: string,
	pool: IPool,
	executablePool: IPool,
	poolAddress: string,
	strike: number,
	maturity: string,
	posKey: PosKey,
	isLeftSide: boolean,
	depositSize: number,
	collateralTokenAddr: string,
	collateralValue: number,
	isCallPool: boolean,
	lpRangeOrders: Position[],
) {
	if (
		posKey.orderType !== OrderType.LONG_COLLATERAL &&
		posKey.orderType !== OrderType.COLLATERAL_SHORT
	) {
		throw new Error(`CSUP order types not yet supported: ${posKey.orderType}`)
	}

	try {
		const depositSizeBigInt = parseEther(depositSize.toString())
		const token = premia.contracts.getTokenContract(
			collateralTokenAddr,
			premia.signer as any,
		)

		const nearestBelow = await pool.getNearestTicksBelow(
			posKey.lower,
			posKey.upper,
		)

		/*
		NOTE: below covers the cases in which we are doing a deposit, but it is with
		collateral and not options. If it is with options, then we do not need any
		approvals for options to be deposited.
	*/

		const approvalRequired =
			(posKey.orderType == OrderType.LONG_COLLATERAL && isLeftSide) ||
			(posKey.orderType == OrderType.COLLATERAL_SHORT && !isLeftSide)

		if (approvalRequired && !maxCollateralApproved) {
			await setApproval(collateralValue, token)
		}

		log.info(
			`Depositing size: ${parseFloat(
				formatEther(depositSizeBigInt),
			)} in ${market} ${maturity}-${strike}-${isCallPool ? 'C' : 'P'} (${
				isLeftSide ? 'LC' : 'CS'
			})`,
		)

		log.debug(
			'Deposit Params:',
			posKey,
			`\n`,
			`Nearest Below Lower: `,
			parseFloat(formatEther(nearestBelow.nearestBelowLower)),
			`\n`,
			`Nearest Below Upper: `,
			parseFloat(formatEther(nearestBelow.nearestBelowUpper)),
			`\n`,
			`Deposit Size: `,
			parseFloat(formatEther(depositSizeBigInt)),
		)

		const depositTx = await executablePool[
			'deposit((address,address,uint256,uint256,uint8),uint256,uint256,uint256,uint256,uint256)'
		](
			posKey,
			nearestBelow.nearestBelowLower,
			nearestBelow.nearestBelowUpper,
			depositSizeBigInt,
			0n,
			parseEther('1'),
			// {
			// 	gasLimit: 10000000, // Fails to properly estimate gas limit
			// },
		)

		const confirm = await provider.waitForTransaction(depositTx.hash, 1)

		if (confirm?.status == 0) {
			log.error('Last Transaction Failed!', confirm)
			return lpRangeOrders
		}

		log.info('Deposit confirmed.')

		const serializedPosKey = {
			owner: posKey.owner,
			operator: posKey.operator,
			lower: formatEther(posKey.lower),
			upper: formatEther(posKey.upper),
			orderType: posKey.orderType,
		}

		lpRangeOrders.push({
			market: market,
			isCall: isCallPool,
			strike: strike,
			maturity: maturity,
			poolAddress,
			depositSize: depositSize,
			posKey: serializedPosKey,
		})

		return lpRangeOrders
	} catch (e) {
		log.error(`Error depositing range order: ${e}`)
		return lpRangeOrders
	}
}

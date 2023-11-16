// noinspection ExceptionCaughtLocallyJS

import { PosKey, Position, MarketParams } from '../utils/types'
import { formatEther, parseEther, formatUnits, parseUnits } from 'ethers'
import { lpAddress, addresses } from '../config/constants'
import {
	autoDeploy,
	defaultSpread,
	maxCollateralApproved,
	maxDeploymentFee,
	minAnnihilationSize,
	minDTE,
	rangeWidthMultiplier,
} from '../config'
import { IPool, OrderType, PoolKey, TokenType } from '@premia/v3-sdk'
import { createExpiration, getDaysToExpiration, getTTM } from '../utils/dates'
import { setApproval } from '../utils/tokens'
import { premia, signerAddress, poolFactory } from '../config/contracts'
import { getValidStrikes } from '../utils/strikes'
import {
	getCollateralApprovalAmount,
	getValidRangeWidth,
} from '../utils/rangeOrders'
import { marketParams } from '../config'
import { log } from '../utils/logs'
import { delay } from '../utils/time'

export async function deployLiquidity(
	lpRangeOrders: Position[],
	market: string,
	spotPrice: number,
) {
	log.app(`Deploying liquidity for ${market}`)

	try {
		for (const maturityString of marketParams[market].maturities) {
			log.info(`Spot Price for ${market}: ${spotPrice}`)
			log.info(`Processing strikes for ${market}-${maturityString} expiration`)

			// calls
			lpRangeOrders = await processStrikes(
				market,
				spotPrice,
				marketParams,
				maturityString,
				true,
				lpRangeOrders,
			)

			// puts
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

	// check if option already expired
	if (daysToExpiration <= 0) {
		log.warning(`Skipping expiration date: ${maturityString} is in the past`)
		return lpRangeOrders
	}

	// check if option expiration is more than 1 year out
	if (daysToExpiration > 365) {
		log.warning(
			`Skipping expiration date: ${maturityString} is more than in 1 year`,
		)
		return lpRangeOrders
	}

	const strikes = await getValidStrikes(
		market,
		spotPrice,
		marketParams,
		maturityString,
		maturityTimestamp,
		isCall,
	)

	for (const { strike, option } of strikes) {
		log.info(`Depositing for ${maturityString}-${strike}-${isCall ? 'C' : 'P'}`)

		const fetchedPoolInfo = await fetchOrDeployPool(
			lpRangeOrders,
			market,
			maturityString,
			maturityTimestamp,
			strike,
			isCall,
		)

		// NOTE: if null, we are skipping the strike due to param checks in fetchOrDeployPool()
		if (!fetchedPoolInfo) continue

		const { multicallPool, executablePool, poolAddress } = fetchedPoolInfo

		let [marketPrice, longBalance, shortBalance] = await Promise.all([
			parseFloat(formatEther(await multicallPool.marketPrice())),

			parseFloat(
				formatEther(await multicallPool.balanceOf(lpAddress!, TokenType.LONG)),
			),
			parseFloat(
				formatEther(await multicallPool.balanceOf(lpAddress!, TokenType.SHORT)),
			),
		])

		// check to see if we have positions that can be annihilated
		await processAnnihilate(
			executablePool,
			market,
			maturityString,
			strike,
			isCall,
			longBalance,
			shortBalance,
		)

		// Option price normalized
		const optionPrice = option.price / spotPrice

		log.debug(`${isCall ? 'Call' : 'Put'} Market Price: ${marketPrice}`)
		log.debug(`${isCall ? 'Call' : 'Put'} Fair Value: ${optionPrice}`)

		/*
			NOTE: for RIGHT SIDE orders if market price > option price than we use market price due
			to issues with crossing markets with range orders (which cause the range order to fail)
 		*/

		const { rightPosKey, rightSideCollateralAmount } =
			await prepareRightSideOrder(
				market,
				strike,
				isCall,
				marketPrice,
				optionPrice,
				longBalance,
			)

		/*
			NOTE: for LEFT SIDE orders if market price < option price than we use market price due
			to issues with crossing markets with range orders (which cause the range order to fail)
			leftPosKey is null when the minOptionPrice config threshold is breached
 		*/

		const { leftPosKey, leftSideCollateralAmount } = await prepareLeftSideOrder(
			marketParams,
			market,
			maturityString,
			strike,
			isCall,
			marketPrice,
			optionPrice,
			shortBalance,
		)

		/*
		NOTE: once the deposits are queued up, we need to do quality control checks to make sure that
		we are not breaching any limits (ie max exposure or low account collateral balance)
		*/

		lpRangeOrders = await processDeposits(
			lpRangeOrders,
			executablePool,
			poolAddress,
			market,
			maturityString,
			strike,
			isCall,
			longBalance,
			shortBalance,
			rightPosKey,
			rightSideCollateralAmount,
			leftPosKey,
			leftSideCollateralAmount,
		)
	}

	return lpRangeOrders
}

async function fetchOrDeployPool(
	lpRangeOrders: Position[],
	market: string,
	maturityString: string,
	maturityTimestamp: number,
	strike: number,
	isCall: boolean,
) {
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

	const found = lpRangeOrders.find(
		(position) =>
			position.poolAddress === poolAddress && position.isCall === isCall,
	)

	if (found) {
		log.warning(
			`Skipping ${market} ${maturityString}-${strike}-${
				isCall ? 'C' : 'P'
			}. Already Deposited.`,
		)
		return null
	}

	if (!isDeployed && !autoDeploy) {
		log.warning(
			`Skipping ${market} ${maturityString}-${strike}-${
				isCall ? 'C' : 'P'
			}. No Pool Exists.`,
		)
		return null
	}

	const ttm = getTTM(maturityTimestamp)

	if (ttm * 365 < minDTE) {
		log.warning(
			`Skipping ${market} ${maturityString} ${isCall ? 'Calls' : 'Puts'}`,
		)
		log.warning(`Option under min DTE. DTE: ${ttm * 365}`)
		return null
	}

	if (!isDeployed && autoDeploy) {
		log.info(`Pool does not exist. Deploying pool now....`)

		try {
			await deployPool(poolKey, market, maturityString, strike, isCall)
		} catch {
			log.warning(
				`Pool was not deployed, skipping ${market} ${maturityString} ${strike} ${
					isCall ? 'Calls' : 'Puts'
				}`,
			)
			return null
		}
	}

	const multicallPool = premia.contracts.getPoolContract(
		poolAddress,
		premia.multicallProvider as any,
	)

	// Create a new provider with signer to execute transactions
	const executablePool = premia.contracts.getPoolContract(
		poolAddress,
		premia.signer as any,
	)

	return { multicallPool, executablePool, poolAddress }
}

async function processAnnihilate(
	executablePool: IPool,
	market: string,
	maturityString: string,
	strike: number,
	isCall: boolean,
	longBalance: number,
	shortBalance: number,
) {
	// annihilation process (preprocess before deposits)
	if (shortBalance > minAnnihilationSize && longBalance > minAnnihilationSize) {
		const annihilationSize = Math.min(longBalance, shortBalance)
		const annihilationSizeBigInt = parseEther(annihilationSize.toString())

		log.info(`Annihilating ${annihilationSize} contracts..`)

		try {
			await annihilatePositions(executablePool, annihilationSizeBigInt)
		} catch {
			log.warning(
				`Annihilation failed for ${market} ${maturityString}-${strike}-${
					isCall ? 'C' : 'P'
				}`,
			)
		}
	}
}

async function processDeposits(
	lpRangeOrders: Position[],
	executablePool: IPool,
	poolAddress: string,
	market: string,
	maturityString: string,
	strike: number,
	isCall: boolean,
	longBalance: number,
	shortBalance: number,
	rightPosKey: PosKey,
	rightSideCollateralAmount: number,
	leftPosKey: PosKey | null,
	leftSideCollateralAmount: number,
) {
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
		token.balanceOf(lpAddress),
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
	// NOTE: if we are using options, then the return value for collateralAmount returns ZERO
	const rightSideUsesOptions = rightSideCollateralAmount == 0
	const leftSideUsesOptions = leftSideCollateralAmount == 0

	// NOTE: we will still post single sided markets with options (close only quoting) so even if we have no
	// collateral but at least one side can use options, we will still post that order.
	// If BOTH orders require collateral and there is not enough for either: skip BOTH deposits
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
		return lpRangeOrders
	}

	// check to see if we have breached our position limit for RIGHT SIDE orders
	if (shortBalance >= marketParams[market].maxExposure) {
		log.warning('Max SHORT exposure reached, no RIGHT SIDE order placed..')
		// if we are posting options only or have sufficient collateral do deposit: process
	} else if (rightSideUsesOptions || sufficientCollateral) {
		// RIGHT SIDE ORDER
		lpRangeOrders = await depositRangeOrderLiq(
			market,
			executablePool,
			poolAddress,
			strike,
			maturityString,
			rightPosKey,
			false,
			marketParams[market].depositSize,
			collateralTokenAddr,
			parseUnits(String(rightSideCollateralAmount), decimals),
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
			executablePool,
			poolAddress,
			strike,
			maturityString,
			leftPosKey,
			true,
			marketParams[market].depositSize,
			collateralTokenAddr,
			parseUnits(String(leftSideCollateralAmount), decimals),
			isCall,
			lpRangeOrders,
		)
	}
	return lpRangeOrders
}

async function prepareRightSideOrder(
	market: string,
	strike: number,
	isCall: boolean,
	marketPrice: number,
	optionPrice: number,
	longBalance: number,
) {
	const rightRefPrice = marketPrice > optionPrice ? marketPrice : optionPrice
	const marketPriceUpper =
		Math.ceil((rightRefPrice * (1 + defaultSpread) + 0.001) * 1000) / 1000
	const targetUpperTick = Math.min(
		1,
		Math.ceil(marketPriceUpper * (1 + rangeWidthMultiplier) * 1000) / 1000,
	)

	log.debug(`${isCall ? 'Call' : 'Put'} marketPriceUpper: ${marketPriceUpper}`)
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

	return {
		rightPosKey,
		rightSideCollateralAmount,
	}
}

async function prepareLeftSideOrder(
	marketParams: MarketParams,
	market: string,
	maturityString: string,
	strike: number,
	isCall: boolean,
	marketPrice: number,
	optionPrice: number,
	shortBalance: number,
) {
	// set default values in case we violate minOptionPrice and skip section
	const leftRefPrice = marketPrice < optionPrice ? marketPrice : optionPrice

	let leftSideCollateralAmount = 0
	let leftPosKey: PosKey | undefined

	// If price is too low, we want to skip this section (we will not post LEFT side order)
	if (leftRefPrice > marketParams[market].minOptionPrice) {
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

		return { leftPosKey, leftSideCollateralAmount }
	} else {
		// If price of option is too low, we do NOT want to place an LEFT side range order
		// NOTE: we do not process a trade if price is equal to minOptionPrice
		log.warning(
			`Option price too low. No LEFT SIDE order generated for ${market} ${strike} ${maturityString} ${
				isCall ? 'Calls' : 'Puts'
			}`,
		)

		return { leftPosKey: null, leftSideCollateralAmount: 0 }
	}
}

async function deployPool(
	poolKey: PoolKey,
	market: string,
	maturityString: string,
	strike: number,
	isCall: boolean,
	retry: boolean = true,
) {
	try {
		const deploymentTx = await poolFactory.deployPool(poolKey, {
			value: parseEther(maxDeploymentFee), // init fee excess refunded
			// gasLimit: 10000000, // fails to properly estimate gas limit
		})

		const confirm = await deploymentTx.wait(1)

		if (confirm?.status == 0) {
			throw new Error(`Failed to confirm pool deployment: ${confirm}`)
		}

		log.info(
			`${market} ${strike} ${maturityString} ${
				isCall ? 'Call' : 'Put'
			} pool deployment confirmed!`,
		)
	} catch (err) {
		await delay(2000)

		if (retry) {
			return deployPool(poolKey, market, maturityString, strike, isCall, false)
		} else {
			log.error(`Error deploying pool: ${err}`)
			throw err
		}
	}
}

async function annihilatePositions(
	executablePool: IPool,
	poolBalance: bigint,
	retry: boolean = true,
) {
	try {
		const annihilateTx = await executablePool.annihilate(poolBalance, {
			gasLimit: 1400000,
		})
		const confirm = await annihilateTx.wait(1)

		if (confirm?.status == 0) {
			throw new Error(
				`Failed to confirm annihilate existing positions: ${confirm}`,
			)
		}

		log.info(`Annihilated existing positions.`)
	} catch (err) {
		await delay(2000)

		if (retry) {
			return annihilatePositions(executablePool, poolBalance, false)
		} else {
			log.error(`Error annihilating positions: ${err}`)
			throw err
		}
	}
}

async function depositRangeOrderLiq(
	market: string,
	executablePool: IPool,
	poolAddress: string,
	strike: number,
	maturity: string,
	posKey: PosKey,
	isLeftSide: boolean,
	depositSize: number,
	collateralTokenAddr: string,
	collateralValue: bigint,
	isCallPool: boolean,
	lpRangeOrders: Position[],
) {
	if (
		posKey.orderType !== OrderType.LONG_COLLATERAL &&
		posKey.orderType !== OrderType.COLLATERAL_SHORT
	) {
		// NOTE: we do not catch this error upstream.
		throw new Error(`CSUP order types not yet supported: ${posKey.orderType}`)
	}

	try {
		const depositSizeBigInt = parseEther(depositSize.toString())
		const token = premia.contracts.getTokenContract(
			collateralTokenAddr,
			premia.signer as any,
		)

		const nearestBelow = await executablePool.getNearestTicksBelow(
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

		try {
			await depositPosition(
				executablePool,
				posKey,
				nearestBelow,
				depositSizeBigInt,
			)
		} catch (err) {
			return lpRangeOrders
		}

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

async function depositPosition(
	executablePool: IPool,
	posKey: PosKey,
	nearestBelow: [bigint, bigint] & {
		nearestBelowLower: bigint
		nearestBelowUpper: bigint
	},
	depositSize: bigint,
	retry: boolean = true,
) {
	try {
		const depositTx = await executablePool[
			'deposit((address,address,uint256,uint256,uint8),uint256,uint256,uint256,uint256,uint256)'
		](
			posKey,
			nearestBelow.nearestBelowLower,
			nearestBelow.nearestBelowUpper,
			depositSize,
			0n,
			parseEther('1'),
			{
				gasLimit: 10000000, // Fails to properly estimate gas limit
			},
		)

		const confirm = await depositTx.wait(1)

		if (confirm?.status == 0) {
			throw new Error(`Failed to confirm deposit of LP Range Order: ${confirm}`)
		}

		log.info(
			`LP Range Order deposit confirmed of size: ${formatEther(depositSize)}`,
		)
	} catch (err) {
		await delay(2000)

		if (retry) {
			return depositPosition(
				executablePool,
				posKey,
				nearestBelow,
				depositSize,
				false,
			)
		} else {
			log.error(`Error depositing LP Range Order: ${err}`)
			throw err
		}
	}
}

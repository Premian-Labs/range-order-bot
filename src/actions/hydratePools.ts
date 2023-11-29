import { formatEther, parseEther, formatUnits, parseUnits } from 'ethers'
import { IPool, OrderType, PoolKey, TokenType } from '@premia/v3-sdk'

import {
	autoDeploy,
	defaultSpread,
	maxCollateralApproved,
	maxDelta,
	minAnnihilationSize,
	minDelta,
	minDTE,
	rangeWidthMultiplier,
	marketParams,
} from '../config'
import {
	premia,
	signerAddress,
	poolFactory,
	botMultiCallProvider,
} from '../config/contracts'
import { lpAddress, addresses } from '../config/constants'
import { state } from '../state'
import { createExpiration, getDaysToExpiration, getTTM } from '../utils/dates'
import { setApproval } from '../utils/tokens'
import { PosKey } from '../utils/types'
import { log } from '../utils/logs'
import { delay } from '../utils/time'
import {
	getCollateralApprovalAmount,
	getValidRangeWidth,
} from '../utils/rangeOrders'

export async function deployLiquidity(market: string, spotPrice: number) {
	log.app(`Deploying liquidity for ${market}`)

	try {
		for (const maturityString of marketParams[market].maturities) {
			log.info(`Spot Price for ${market}: ${spotPrice}`)
			log.info(`Processing strikes for ${market}-${maturityString} expiration`)

			// calls
			await processStrikes(market, spotPrice, maturityString, true)

			// puts
			await processStrikes(market, spotPrice, maturityString, false)
		}
	} catch (err) {
		log.error(`Error deploying liquidity: ${err}`)
		log.debug(
			`Current LP Positions: ${JSON.stringify(state.lpRangeOrders, null, 4)}`,
		)
		return
	}

	log.info(`All Positions Successfully Processed for ${market}!`)
	log.debug(
		`Current LP Positions: ${JSON.stringify(state.lpRangeOrders, null, 4)}`,
	)
}

export async function processStrikes(
	market: string,
	spotPrice: number,
	maturityString: string,
	isCall: boolean,
) {
	// format exp 15SEP23 => 1234567891
	const maturityTimestamp = createExpiration(maturityString)
	const daysToExpiration = getDaysToExpiration(maturityString)

	log.debug(`Maturity TS: ${maturityTimestamp} (${daysToExpiration} DTE)`)

	// check if option already expired
	if (daysToExpiration <= 0) {
		log.warning(`Skipping expiration date: ${maturityString} is in the past`)
		return
	}

	// check if option expiration is more than 1 year out
	if (daysToExpiration > 365) {
		log.warning(
			`Skipping expiration date: ${maturityString} is more than 1 year out`,
		)
		return
	}

	// Find options by market, type, and maturity
	const filteredOptionParams = state.optionParams.filter((option) => {
		return (
			option.market === market &&
			option.isCall === isCall &&
			option.maturity === maturityString
		)
	})

	for (const op of filteredOptionParams) {
		// critical error in market, skip ALL deposits
		if (op.ivOracleFailure || op.spotOracleFailure) {
			log.warning(
				`Due to oracle failure we can not process ${
					isCall ? 'Call' : 'Put'
				} deposits in ${op.market}`,
			)
			break
		}

		// Skip the deposit if range order is not due for a cycle update (we never withdrew)
		if (!op.cycleOrders) {
			log.debug(
				`${op.market}-${op.maturity}-${op.strike}-${
					op.isCall ? 'C' : 'P'
				} did not breach update threshold...checking next market`,
			)
			continue
		}

		// NOTE: we know delta exists because we checked for iv oracle failure
		const maxDeltaThreshold = Math.abs(op.delta!) > maxDelta
		const minDeltaThreshold = Math.abs(op.delta!) < minDelta

		if (maxDeltaThreshold || minDeltaThreshold) {
			log.warning(
				`Skipping ${op.market}-${op.maturity}-${op.strike}-${
					op.isCall ? 'C' : 'P'
				}'}`,
			)

			log.warning(`Option out of delta range. Delta: ${op.delta}`)
			continue
		}

		log.info(
			`Depositing for ${op.maturity}-${op.strike}-${op.isCall ? 'C' : 'P'}`,
		)

		// NOTE: if null, we don't process strike for deposit
		const fetchedPoolInfo = await fetchOrDeployPool(
			op.market,
			op.maturity,
			maturityTimestamp,
			op.strike,
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
			op.market,
			op.maturity,
			op.strike,
			isCall,
			longBalance,
			shortBalance,
		)

		// Option price normalized
		// NOTE: we checked for oracle failure so optionPrice should exist
		const optionPrice = op.optionPrice! / spotPrice

		log.debug(`OptionPrice: ${op.optionPrice!}`)
		log.debug(`SpotPrice: ${spotPrice}`)
		log.debug(`${isCall ? 'Call' : 'Put'} Market Price: ${marketPrice}`)
		log.debug(`${isCall ? 'Call' : 'Put'} Fair Value: ${optionPrice}`)

		/*
			NOTE: for RIGHT SIDE orders if market price > option price than we use market price due
			to issues with crossing markets with range orders (which cause the range order to fail)
 		*/

		const { rightPosKey, rightSideCollateralAmount } =
			await prepareRightSideOrder(
				op.market,
				op.strike,
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
			op.market,
			op.maturity,
			op.strike,
			isCall,
			marketPrice,
			optionPrice,
			shortBalance,
		)

		/*
			NOTE: once the deposits are queued up, we need to do quality control checks to make sure that
			we are not breaching any limits (ie max exposure or low account collateral balance)
		*/

		await processDeposits(
			executablePool,
			poolAddress,
			op.market,
			op.maturity,
			op.strike,
			isCall,
			longBalance,
			shortBalance,
			rightPosKey,
			rightSideCollateralAmount,
			leftPosKey,
			leftSideCollateralAmount,
		)

		/* 
			NOTE: Find option using market/maturity/type/strike (should only be one)
		
			IMPORTANT: We use the unfiltered state.optionParams
		*/
		const optionIndex = state.optionParams.findIndex(
			(option) =>
				option.market === op.market &&
				option.maturity === op.maturity &&
				option.isCall === isCall &&
				option.strike === op.strike,
		)

		// IMPORTANT: -1 is returned if lpRangeOrder is not in state.optionParams. If this is the case there is a bug
		if (optionIndex == -1) {
			throw new Error(
				'lpRangeOrder was not traceable in state.optionParams. Please contact dev team',
			)
		}

		// IMPORTANT: after processing a deposit, turn update to false
		state.optionParams[optionIndex].cycleOrders = false
	}
}

async function fetchOrDeployPool(
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

	let poolAddress: string
	let isDeployed: boolean
	try {
		;[poolAddress, isDeployed] = await poolFactory.getPoolAddress(poolKey)
	} catch (e) {
		log.warning(
			`${market} ${maturityString}-${strike}-${
				isCall ? 'C' : 'P'
			}. Cannot be Deployed.`,
		)
		return null
	}

	log.debug(`${isCall ? 'Call' : 'Put'} poolAddress: ${poolAddress}`)

	if (isDeployed) {
		log.debug(
			`${market} ${maturityString}-${strike}-${
				isCall ? 'C' : 'P'
			}. Already Deployed.`,
		)
		const multicallPool = premia.contracts.getPoolContract(
			poolAddress,
			botMultiCallProvider,
		)

		// Create a new provider with signer to execute transactions
		const executablePool = premia.contracts.getPoolContract(
			poolAddress,
			premia.signer as any,
		)

		return { multicallPool, executablePool, poolAddress }
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
		botMultiCallProvider,
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
		botMultiCallProvider,
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

	/* 
		NOTE: We will still post single sided markets with options (close only quoting) so even if we have no
			  collateral but at least one side can use options, we will still post that order.

			  If BOTH orders require collateral and there is not enough for either: skip BOTH deposits.
	*/
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
		return
	}

	// check to see if we have breached our position limit for RIGHT SIDE orders
	if (shortBalance >= marketParams[market].maxExposure) {
		log.warning('Max SHORT exposure reached, no RIGHT SIDE order placed..')
		// if we are posting options only or have sufficient collateral do deposit: process
	} else if (rightSideUsesOptions || sufficientCollateral) {
		// RIGHT SIDE ORDER
		await depositRangeOrderLiq(
			market,
			executablePool,
			poolAddress,
			strike,
			maturityString,
			rightPosKey,
			false,
			collateralTokenAddr,
			parseUnits(String(rightSideCollateralAmount), decimals),
			isCall,
		)
	}

	// check to see if we have breached our position limit for RIGHT SIDE orders
	if (longBalance >= marketParams[market].maxExposure) {
		log.warning('Max LONG exposure reached, no LEFT SIDE order placed..')
		// if we are posting options only or have sufficient collateral do deposit: process
	} else if (leftPosKey && (leftSideUsesOptions || sufficientCollateral)) {
		// LEFT SIDE ORDER
		await depositRangeOrderLiq(
			market,
			executablePool,
			poolAddress,
			strike,
			maturityString,
			leftPosKey,
			true,
			collateralTokenAddr,
			parseUnits(String(leftSideCollateralAmount), decimals),
			isCall,
		)
	}
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

		// NOTE: if using options for a LEFT side order, collateral amount is ZERO
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
			gasLimit: 3_000_000, // fails to properly estimate gas limit
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
			gasLimit: 3_000_000,
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
	collateralTokenAddr: string,
	collateralValue: bigint,
	isCallPool: boolean,
) {
	if (
		posKey.orderType !== OrderType.LONG_COLLATERAL &&
		posKey.orderType !== OrderType.COLLATERAL_SHORT
	) {
		// NOTE: we do not catch this error upstream.
		throw new Error(`CSUP order types not yet supported: ${posKey.orderType}`)
	}

	try {
		const depositSizeBigInt = parseEther(
			marketParams[market].depositSize.toString(),
		)
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
			return
		}

		const serializedPosKey = {
			owner: posKey.owner,
			operator: posKey.operator,
			lower: formatEther(posKey.lower),
			upper: formatEther(posKey.upper),
			orderType: posKey.orderType,
		}

		state.lpRangeOrders.push({
			market: market,
			isCall: isCallPool,
			strike: strike,
			maturity: maturity,
			poolAddress,
			depositSize: marketParams[market].depositSize,
			posKey: serializedPosKey,
		})
	} catch (err) {
		log.error(`Error depositing range order: ${err}`)
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
				gasLimit: 3_000_000, // Fails to properly estimate gas limit
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

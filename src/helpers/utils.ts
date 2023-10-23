import moment from 'moment/moment'
import {
	IERC20,
	IERC20__factory,
	IPool,
	IPool__factory,
	IPoolFactory__factory,
	IVolatilityOracle__factory,
} from '../../typechain'
import {
	OrderType,
	PosKey,
	Position,
	MarketParams,
	PoolKey,
	TokenType,
	TokenIdParams,
} from '../types'
import {
	formatEther,
	JsonRpcProvider,
	parseEther,
	parseUnits,
	formatUnits,
	Signer,
	Wallet,
	toBigInt,
	ContractTransactionResponse,
	TransactionReceipt,
} from 'ethers'
import {
	lpAddress,
	privateKey,
	productionTokenAddr,
	rpcUrl,
	rpcUrlOracle,
	SECONDSINYEAR,
	volatilityOracle,
	minTickDistance,
	addresses,
} from '../config/constants'
import {
	autoDeploy,
	defaultSpread,
	maxCollateralApproved,
	maxDelta,
	maxDeploymentFee,
	minAnnihilationSize,
	minDelta,
	minDTE,
	minOptionPrice,
	rangeWidthMultiplier,
	riskFreeRate,
} from '../config/liquiditySettings'
import { BlackScholes, Option } from '@uqee/black-scholes'

const blackScholes: BlackScholes = new BlackScholes()
const provider = new JsonRpcProvider(rpcUrl)
const signer = new Wallet(privateKey!, provider) // NOTE: private key is checked in liquiditySettings.ts

// contracts
const poolFactory = IPoolFactory__factory.connect(
	addresses.core.PoolFactoryProxy.address,
	signer,
)

// NOTE: Oracle is only available on Arbitrum which is why it has its own provider
const providerOracle = new JsonRpcProvider(rpcUrlOracle)
const ivOracle = IVolatilityOracle__factory.connect(
	volatilityOracle,
	providerOracle,
)

const validWidths = [
	1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 80, 100, 125, 128, 160, 200,
	250, 256, 320, 400, 500, 512, 625, 640, 800,
]

function createExpiration(exp: string): number {
	const expirationMoment = moment.utc(exp, 'DDMMMYY')

	// 1.0 check if option expiration is a valid date
	if (!expirationMoment.isValid()) {
		throw new Error(`Invalid expiration date: ${exp}`)
	}

	const today = moment.utc().startOf('day')
	// NOTE: this returns a floor integer value for day (ie 1.9 days -> 1)
	const daysToExpiration = expirationMoment.diff(today, 'days')

	// 1.1 check if option already expired
	if (daysToExpiration <= 0) {
		throw new Error(`Invalid expiration date: ${exp} is in the past`)
	}

	// 1.2 check if option expiration is more than 1 year out
	if (expirationMoment.diff(today, 'years') > 0) {
		throw new Error(`Invalid expiration date: ${exp} is more then in 1 year`)
	}

	// 2. DAILY OPTIONS: if option expiration is tomorrow or the day after tomorrow, return as valid
	if (daysToExpiration === 1 || daysToExpiration === 2) {
		// Set time to 8:00 AM
		return expirationMoment.add(8, 'hours').unix()
	}

	// 3. WEEKLY OPTIONS: check if option expiration is Friday
	if (expirationMoment.day() !== 5) {
		throw new Error(`${expirationMoment.toJSON()} is not Friday!`)
	}

	// 4. MONTHLY OPTIONS: if option maturity > 30 days, validate expire is last Friday of the month
	if (daysToExpiration > 30) {
		const lastDay = expirationMoment.clone().endOf('month').startOf('day')
		lastDay.subtract((lastDay.day() + 2) % 7, 'days')

		if (!lastDay.isSame(expirationMoment)) {
			throw new Error(
				`${expirationMoment.toJSON()} is not the last Friday of the month!`,
			)
		}
	}

	// Set time to 8:00 AM
	return expirationMoment.add(8, 'hours').unix()
}

async function setApproval(
	market: string,
	isCallPool: boolean,
	collateralValue: number,
	erc20: IERC20,
) {
	let approvalBigInt: bigint
	if (market === 'WBTC' && isCallPool) {
		collateralValue = Math.ceil(collateralValue * 1e8) / 1e8
		// WBTC is 8 decimals
		approvalBigInt = parseUnits(collateralValue.toString(), 8)
	} else if (!isCallPool) {
		collateralValue = Math.ceil(collateralValue * 1e6) / 1e6
		// ALL Puts are in USDC and are 6 decimals
		approvalBigInt = parseUnits(collateralValue.toString(), 6)
	} else {
		collateralValue = Math.ceil(collateralValue * 1e18) / 1e18
		// All other calls are 18 decimals
		approvalBigInt = parseUnits(collateralValue.toString(), 18)
	}
	// Set approval
	// TODO: what happens if this fails, we will fail downstream
	try {
		await erc20.approve(addresses.core.ERC20Router.address, approvalBigInt)
	} catch (e) {
		await delay(2000)
		try {
			await erc20.approve(addresses.core.ERC20Router.address, approvalBigInt)
		} catch (e) {
			console.log(`WARNING: was NOT able to approve ${market} collateral!`)
		}
	}
}
async function getCollateralApprovalAmt(
	market: string,
	posKey: PosKey,
	isLeftSide: boolean,
	isCallPool: boolean,
	depositSize: number,
	strike: number,
) {
	let collateralName = market
	// Left side order using (collateral only)
	if (posKey.orderType == OrderType.LC && isLeftSide) {
		// NOTE: all values are standard format
		const lowerTick = parseFloat(formatEther(posKey.lower))
		const upperTick = parseFloat(formatEther(posKey.upper))
		const avePrice = (lowerTick + upperTick) / 2
		let collateralValue = depositSize * avePrice
		if (!isCallPool) {
			collateralValue = depositSize * strike * avePrice
			collateralName = 'USDC'
		}
		console.log(
			`LEFT side collateral required: ${collateralValue} ${collateralName}`,
		)
		return collateralValue
		// Right side order using (collateral only)
	} else if (posKey.orderType == OrderType.CS && !isLeftSide) {
		let collateralValue = depositSize
		if (!isCallPool) {
			collateralValue = depositSize * strike
			collateralName = 'USDC'
		}
		console.log(
			`RIGHT side collateral required: ${collateralValue} ${collateralName}`,
		)
		return collateralValue
	} else {
		/*
		NOTE: all other cases, we are  use options instead of collateral so the collateral
		amount to approve is zero
		ie order type CS & isLeftSide -> short options being posted on LEFT side
		*/
		return 0
	}
}
async function depositRangeOrderLiq(
	market: string,
	pool: IPool,
	strike: number,
	maturity: string,
	posKey: PosKey,
	isLeftSide: boolean,
	depositSize: number,
	signer: Signer,
	provider: JsonRpcProvider,
	collateralTokenAddr: string,
	collateralValue: number,
	isCallPool: boolean,
	lpRangeOrders: Position[],
) {
	if (posKey.orderType !== OrderType.LC && posKey.orderType !== OrderType.CS)
		throw new Error(`CSUP order types not supported: ${posKey.orderType}`)

	const depositSizeBigInt = parseEther(depositSize.toString())
	const erc20 = IERC20__factory.connect(collateralTokenAddr, signer)

	const nearestBelow = await pool.getNearestTicksBelow(
		posKey.lower,
		posKey.upper,
	)

	/*
	NOTE: below covers the cases in which we are doing a deposit, but it is with
	collateral and not options. If it is with options, then we do not need any
	approvals for options to be deposited.
	*/

	// LEFT SIDE: collateral deposit w/o approval
	if (
		posKey.orderType == OrderType.LC &&
		isLeftSide &&
		!maxCollateralApproved
	) {
		await setApproval(market, isCallPool, collateralValue, erc20)
		// RIGHT SIDE: collateral deposit w/o approval
	} else if (
		posKey.orderType == OrderType.CS &&
		!isLeftSide &&
		!maxCollateralApproved
	) {
		await setApproval(market, isCallPool, collateralValue, erc20)
	}

	console.log(
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

	let depositTx: ContractTransactionResponse
	let confirm: TransactionReceipt | null
	try {
		depositTx = await pool[
			'deposit((address,address,uint256,uint256,uint8),uint256,uint256,uint256,uint256,uint256)'
		](
			posKey,
			nearestBelow.nearestBelowLower,
			nearestBelow.nearestBelowUpper,
			depositSizeBigInt,
			0n,
			parseEther('1'),
			{
				gasLimit: 10000000, // Fails to properly estimate gas limit
			},
		)
		confirm = await provider.waitForTransaction(depositTx.hash, 1)
		console.log('Confirmation status:', confirm?.status)
	} catch (e) {
		await delay(2000)
		try {
			depositTx = await pool[
				'deposit((address,address,uint256,uint256,uint8),uint256,uint256,uint256,uint256,uint256)'
			](
				posKey,
				nearestBelow.nearestBelowLower,
				nearestBelow.nearestBelowUpper,
				depositSizeBigInt,
				0n,
				parseEther('1'),
				{
					gasLimit: 10000000, // Fails to properly estimate gas limit
				},
			)
			confirm = await provider.waitForTransaction(depositTx.hash, 1)
			console.log('Confirmation status:', confirm?.status)
		} catch (e) {
			console.log(`WARNING: Could NOT make a deposit!`)
			console.log(e)
			confirm = null
		}
	}

	// NOTE: issues beyond a provider error are covered here.
	if (confirm?.status == 0) {
		console.log('Last Transaction Failed!')
		console.log(confirm)
		return lpRangeOrders
	}
	// Successful transaction
	if (confirm?.status == 1) {
		console.log('Deposit Confirmed!')
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
		poolAddress: await pool.getAddress(),
		depositSize: depositSize,
		posKey: serializedPosKey,
	})

	return lpRangeOrders
}

function getValidRangeWidth(
	lowerTick: number,
	upperTick: number,
	orderType: string,
) {
	if (upperTick <= lowerTick) throw new Error('Check tick spacing')
	if (lowerTick <= 0 || upperTick <= 0)
		throw new Error('Tick can not be Zero or Negative')
	if ((upperTick * 1000) % 1 !== 0)
		throw new Error('Upper tick precision too high')
	if ((lowerTick * 1000) % 1 !== 0)
		throw new Error('Lower tick precision too high')

	const upperTickScaled = upperTick * 1000
	const lowerTickerScaled = lowerTick * 1000
	const targetWidth = upperTickScaled - lowerTickerScaled

	const closestWidth = validWidths.reduce((prev, curr) => {
		return Math.abs(curr - targetWidth) < Math.abs(prev - targetWidth)
			? curr
			: prev
	})

	if (orderType === 'RIGHT') {
		console.log('lowerTickerScaled:', lowerTickerScaled)
		console.log('closestWidth:', closestWidth)
		let adjustedUpperTick = lowerTickerScaled + closestWidth
		if (adjustedUpperTick > 1000) {
			console.log('Closest width too large, trying next lowest....')
			const currentWidthIndex = validWidths.indexOf(closestWidth)
			if (currentWidthIndex - 1 < 0)
				throw new Error('Your shit is broken, fix it....')
			adjustedUpperTick = lowerTickerScaled + validWidths[currentWidthIndex - 1]
		}
		if (adjustedUpperTick > 1000)
			throw new Error('Adjust Upper ticker can not be greater than 1')
		if (adjustedUpperTick <= lowerTickerScaled)
			throw new Error('Adjust upper tick collision')
		return [lowerTickerScaled / 1000, adjustedUpperTick / 1000]
	} else if (orderType === 'LEFT') {
		let adjustedLowerTick = upperTickScaled - closestWidth
		if (adjustedLowerTick <= 0)
			throw new Error('Adjust lower ticker can not be Zero or Negative')
		if (adjustedLowerTick >= upperTickScaled)
			throw new Error('Adjust lower tick collision')
		return [adjustedLowerTick / 1000, upperTickScaled / 1000]
	} else {
		throw new Error('Wrong order type')
	}
}

export async function delay(t: number) {
	await new Promise((resolve) => setTimeout(resolve, t))
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
	console.log(`Maturity TS: ${maturityTimestamp}`)

	const strikes = isCall
		? marketParams[market].callStrikes
		: marketParams[market].putStrikes

	for (const strike of strikes) {
		console.log(
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
		console.log(`${isCall ? 'Call' : 'Put'} PoolKey:`, poolKey)
		const [poolAddress, isDeployed] = await poolFactory.getPoolAddress(poolKey)
		console.log(`${isCall ? 'Call' : 'Put'} poolAddress: ${poolAddress}`)

		if (!isDeployed && !autoDeploy) {
			console.log(
				`WARNING: Skipping ${market} ${maturityString} ${
					isCall ? 'Calls' : 'Puts'
				}. No Pool Exists `,
			)
			continue
		}

		const ts = moment.utc().unix()
		const ttm = (maturityTimestamp - ts) / SECONDSINYEAR

		const iv = await ivOracle['getVolatility(address,uint256,uint256,uint256)'](
			productionTokenAddr[market], //NOTE: we use production addresses only
			parseEther(spotPrice.toString()),
			parseEther(strike.toString()),
			parseEther(ttm.toString()),
		)

		console.log(
			`IV for ${market} ${strike} ${maturityString}: ${parseFloat(
				formatEther(iv),
			)}`,
		)

		const option: Option = blackScholes.option({
			rate: riskFreeRate,
			sigma: parseFloat(formatEther(iv)),
			strike: strike,
			time: ttm,
			type: isCall ? 'call' : 'put',
			underlying: spotPrice,
		})

		const maxDeltaThreshold = Math.abs(option.delta) > maxDelta
		const minDeltaThreshold = Math.abs(option.delta) < minDelta
		const dteThreshold = ttm * 365 < minDTE

		if (maxDeltaThreshold || minDeltaThreshold || dteThreshold) {
			console.log(
				`WARNING: Skipping ${market} ${maturityString} ${
					isCall ? 'Calls' : 'Puts'
				}`,
			)
			console.log(`option out of range`)
			console.log(`Delta:${option.delta}`)
			console.log(`DTE: ${ttm * 365}`)
			continue
		}
		if (!isDeployed && autoDeploy) {
			console.log(`Pool does not exist. Deploying pool now....`)
			//TODO: what happens if we cant deploy (it will fail downstream)

			let deploymentTx: ContractTransactionResponse
			let confirm: TransactionReceipt | null
			try {
				deploymentTx = await poolFactory.deployPool(poolKey, {
					value: parseEther(maxDeploymentFee), //init fee. excess refunded
					gasLimit: 10000000, // Fails to properly estimate gas limit
				})
				confirm = await provider.waitForTransaction(deploymentTx.hash, 1)
			} catch (e) {
				await delay(2000)
				try {
					deploymentTx = await poolFactory.deployPool(poolKey, {
						value: parseEther(maxDeploymentFee), //init fee. excess refunded
						gasLimit: 10000000, // Fails to properly estimate gas limit
					})
					confirm = await provider.waitForTransaction(deploymentTx.hash, 1)
				} catch (e) {
					console.log(
						`WARNING: failed to deploy pool for ${market} ${strike} ${
							isCall ? 'Calls' : 'Puts'
						} for ${maturityString} `,
					)
					console.log(e)
					confirm = null
				}
			}

			// NOTE: issues beyond a provider error are covered here
			if (confirm?.status == 0) {
				console.log(
					`WARNING: pool was not deployed, skipping ${market} ${maturityString} ${
						isCall ? 'Calls' : 'Puts'
					}`,
				)
				console.log(confirm)
				continue
			}

			// Successful transaction
			if (confirm?.status == 1) {
				console.log(
					`${market} ${maturityString} ${
						isCall ? 'Call' : 'Put'
					} pool deployment confirmed!`,
				)
			}
		}

		const pool = IPool__factory.connect(poolAddress, signer)
		const marketPrice = parseFloat(formatEther(await pool.marketPrice()))
		console.log(`${isCall ? 'Call' : 'Put'} MarketPrice: ${marketPrice}`)

		// Option price normalized
		const optionPrice = option.price / spotPrice
		console.log(`${isCall ? 'Call' : 'Put'} Fair Value: ${optionPrice}`)

		// check to see if we have positions that can be annihilated
		let longBalance = parseFloat(
			formatEther(await pool.balanceOf(lpAddress!, TokenType.LONG)),
		)
		let shortBalance = parseFloat(
			formatEther(await pool.balanceOf(lpAddress!, TokenType.SHORT)),
		)

		// annihilation process (preprocess before deposits)
		if (
			shortBalance > minAnnihilationSize &&
			longBalance > minAnnihilationSize
		) {
			const annihilationSize = Math.min(longBalance, shortBalance)
			console.log(`Annihilating ${annihilationSize} contracts..`)
			const annihilationSizeBigInt = parseEther(annihilationSize.toString())

			let annihilateTx: ContractTransactionResponse
			let confirm: TransactionReceipt | null

			try {
				annihilateTx = await pool.annihilate(annihilationSizeBigInt, {
					gasLimit: 1400000,
				})
				confirm = await provider.waitForTransaction(annihilateTx.hash, 1)
			} catch (e) {
				await delay(2000)
				try {
					annihilateTx = await pool.annihilate(annihilationSizeBigInt, {
						gasLimit: 1400000,
					})
					confirm = await provider.waitForTransaction(annihilateTx.hash, 1)
				} catch (e) {
					console.log(
						`WARNING: unable to annihilate ${market} ${strike} ${
							isCall ? 'Calls' : 'Puts'
						} for ${maturityString}`,
					)
					console.log(e)
					confirm = null
				}
			}

			// NOTE: issues beyond a provider error are covered here
			if (confirm?.status == 0) {
				console.log('WARNING: failed to annihilate existing positions!')
			}

			// Successful transaction
			if (confirm?.status == 1) {
				console.log(`Annihilation Successful!`)
				// Update balances post annihilation
				longBalance = parseFloat(
					formatEther(await pool.balanceOf(lpAddress!, TokenType.LONG)),
				)
				shortBalance = parseFloat(
					formatEther(await pool.balanceOf(lpAddress!, TokenType.LONG)),
				)
			}
		}

		/*
		=========================================================================================
		================================RIGHT SIDE SETUP=========================================
		=========================================================================================

		NOTE: for RIGHT SIDE orders if market price > option price than we use market price due
		to issues with crossing markets with range orders (which cause the range order to fail)
 		*/
		let rightPosKey: PosKey
		const rightRefPrice = marketPrice > optionPrice ? marketPrice : optionPrice
		const marketPriceUpper =
			Math.ceil((rightRefPrice * (1 + defaultSpread) + 0.001) * 1000) / 1000
		let targetUpperTick =
			Math.ceil(marketPriceUpper * (1 + rangeWidthMultiplier) * 1000) / 1000
		targetUpperTick = targetUpperTick > 1 ? 1 : targetUpperTick
		console.log(
			`${isCall ? 'Call' : 'Put'} marketPriceUpper: ${marketPriceUpper}`,
		)
		console.log(`${isCall ? 'Call' : 'Put'} targetUpper: ${targetUpperTick}`)

		const [lowerTickCS, upperTickCS] = getValidRangeWidth(
			marketPriceUpper,
			targetUpperTick,
			'RIGHT',
		)

		console.log(
			`Final RIGHT SIDE Order-> Lower: ${lowerTickCS} and Upper: ${upperTickCS}`,
		)

		// if we have enough long positions for a right side order, use it instead
		const rightOrderType =
			longBalance > marketParams[market].depositSize
				? OrderType.LC
				: OrderType.CS

		rightPosKey = {
			owner: signer.address,
			operator: signer.address,
			lower: parseEther(lowerTickCS.toString()),
			upper: parseEther(upperTickCS.toString()),
			orderType: rightOrderType,
		}

		// NOTE: if using options for a RIGHT side order, collateral amt is ZERO
		const rightSideCollateralAmt = await getCollateralApprovalAmt(
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
		let leftSideCollateralAmt = 0
		let leftPosKey: PosKey = {
			owner: '',
			operator: '',
			lower: 0n,
			upper: 0n,
			orderType: 1,
		}

		const leftRefPrice = marketPrice < optionPrice ? marketPrice : optionPrice
		// If price is too low, we want to skip this section (we will not post LEFT side order)
		if (leftRefPrice > minOptionPrice) {
			const marketPriceLower =
				Math.floor((leftRefPrice * (1 - defaultSpread) - 0.001) * 1000) / 1000
			const targetLowerTick =
				Math.ceil(marketPriceLower * (1 - rangeWidthMultiplier) * 1000) / 1000

			console.log(
				`${isCall ? 'Call' : 'Put'} marketPriceLower: ${marketPriceLower}`,
			)
			console.log(`${isCall ? 'Call' : 'Put'} targetLower: ${targetLowerTick}`)

			const [lowerTickLC, upperTickLC] = getValidRangeWidth(
				targetLowerTick,
				marketPriceLower,
				'LEFT',
			)

			console.log(
				`Final LEFT SIDE Order-> Lower: ${lowerTickLC} and Upper: ${upperTickLC}`,
			)

			// if we have enough short positions, use it instead
			const leftOrderType =
				shortBalance > marketParams[market].depositSize
					? OrderType.CS
					: OrderType.LC

			leftPosKey = {
				owner: signer.address,
				operator: signer.address,
				lower: parseEther(lowerTickLC.toString()),
				upper: parseEther(upperTickLC.toString()),
				orderType: leftOrderType,
			}

			// NOTE: if using options for a LEFT side order, collateral amt is ZERO
			leftSideCollateralAmt = await getCollateralApprovalAmt(
				market,
				leftPosKey,
				true,
				isCall,
				marketParams[market].depositSize,
				strike,
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

		const erc20 = IERC20__factory.connect(collateralTokenAddr, signer)

		// find the appropriate collateral balance (formatted)
		let collateralBalance: number
		if (market === 'WBTC' && isCall)
			// WBTC is 8 decimals
			collateralBalance = parseFloat(
				formatUnits(await erc20.balanceOf(lpAddress!), 8),
			)
		else if (!isCall)
			// ALL Puts are in USDC and are 6 decimals
			collateralBalance = parseFloat(
				formatUnits(await erc20.balanceOf(lpAddress!), 6),
			)
		// All other calls are 18 decimals
		else
			collateralBalance = parseFloat(
				formatEther(await erc20.balanceOf(lpAddress!)),
			)

		console.log(
			`Collateral token balance: ${collateralBalance} ${
				isCall ? market : 'USDC'
			}`,
		)

		// determine deposit capabilities
		const sufficientCollateral =
			collateralBalance >= rightSideCollateralAmt + leftSideCollateralAmt
		const rightSideUsesOptions = rightSideCollateralAmt == 0
		const leftSideUsesOptions = leftSideCollateralAmt == 0

		// NOTE: we will still post single sided markets with options (close only quoting)
		// If both orders require collateral and there is not enough for either: skip BOTH deposits
		if (
			!sufficientCollateral &&
			leftSideCollateralAmt > 0 &&
			rightSideCollateralAmt > 0
		) {
			console.log(
				`WARNING: INSUFFICIENT COLLATERAL BALANCE. No collateral based range deposits made for 
				${market} 
				${maturityString} 
				${strike} 
				${isCall ? 'Call' : 'Put'}`,
			)
			continue
		}

		// check to see if we have breached our position limit for RIGHT SIDE orders
		if (shortBalance >= marketParams[market].maxExposure) {
			console.log(
				'WARNING: max SHORT exposure reached, no RIGHT SIDE order placed..',
			)
			// if we are posting options only or have sufficient collateral do deposit: process
		} else if (rightSideUsesOptions || sufficientCollateral) {
			// RIGHT SIDE ORDER
			lpRangeOrders = await depositRangeOrderLiq(
				market,
				pool,
				strike,
				maturityString,
				rightPosKey,
				false,
				marketParams[market].depositSize,
				signer,
				provider,
				collateralTokenAddr,
				rightSideCollateralAmt,
				isCall,
				lpRangeOrders,
			)
		}
		// check to see if we have breached our position limit for RIGHT SIDE orders
		if (longBalance >= marketParams[market].maxExposure) {
			console.log(
				'WARNING: max LONG exposure reached, no LEFT SIDE order placed..',
			)
			// If price of option is too low, we do NOT want to place an LEFT side range order
			// NOTE: we do not process a trade if price is equal to minOptionPrice
		} else if (leftRefPrice <= minOptionPrice) {
			console.log(
				`WARNING: Option price too low. No LEFT SIDE order generated for ${market} ${strike} ${maturityString} ${
					isCall ? 'Calls' : 'Puts'
				}`,
			)
			// if we are posting options only or have sufficient collateral do deposit: process
		} else if (leftSideUsesOptions || sufficientCollateral) {
			lpRangeOrders = await depositRangeOrderLiq(
				market,
				pool,
				strike,
				maturityString,
				leftPosKey,
				true,
				marketParams[market].depositSize,
				signer,
				provider,
				collateralTokenAddr,
				leftSideCollateralAmt,
				isCall,
				lpRangeOrders,
			)
		}
	}
	return lpRangeOrders
}

export function formatTokenId({
	version,
	operator,
	lower,
	upper,
	orderType,
}: TokenIdParams) {
	let tokenId = toBigInt(version) << 252n
	tokenId = tokenId + (toBigInt(orderType.valueOf()) << 180n)
	tokenId = tokenId + (toBigInt(operator) << 20n)
	tokenId = tokenId + ((toBigInt(upper) / minTickDistance) << 10n)
	tokenId = tokenId + toBigInt(lower) / minTickDistance

	return tokenId
}

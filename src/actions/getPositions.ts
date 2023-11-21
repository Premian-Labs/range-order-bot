import { IPool, PoolKey } from '@premia/v3-sdk'
import { parseEther, formatEther } from 'ethers'
import { marketParams } from '../config'
import { lpAddress, addresses } from '../config/constants'
import { Position } from '../utils/types'
import flatten from 'lodash.flatten'
import {
	createExpiration,
	getLast30Days,
	nextYearOfMaturities,
} from '../utils/dates'
import { premia, botMultiCallProvider, poolFactory } from '../config/contracts'
import { parseTokenId } from '../utils/tokens'
import { log } from '../utils/logs'

// NOTE: this will find ALL range orders by user (not just from the bot)
// IMPORTANT: can ONLY be run if BOTH call/put strikes exist in marketParams
export async function getExistingPositions(market: string) {
	let processedRangeOrders: Position[][] = []

	log.info(`Getting existing positions for: ${market}`)

	try {
		const maturities = [...getLast30Days(), ...nextYearOfMaturities()].map(
			// NOTE: maturity now follows "03NOV23" string format
			(maturity) => maturity.format('DDMMMYY').toUpperCase(),
		)

		processedRangeOrders = await Promise.all(
			maturities.map((maturityString) =>
				processMaturity(maturityString, market),
			),
		)

		log.info(`Finished getting existing positions!`)
		log.info(
			`Current LP Positions: ${JSON.stringify(processedRangeOrders, null, 4)}`,
		)
	} catch (err) {
		log.error(`Error getting existing positions: ${err}`)
		log.debug(
			`Current LP Positions: ${JSON.stringify(processedRangeOrders, null, 4)}`,
		)
	}

	// NOTE: lpRangeOrders array is populated in the last function call => processTokenIds ()
	return flatten(processedRangeOrders)
}

async function processMaturity(maturityString: string, market: string) {
	let maturityTimestamp: number

	try {
		// 10NOV23 => 1233645758
		maturityTimestamp = createExpiration(maturityString)
	} catch {
		log.error(`Invalid maturity: ${maturityString}`)
		return []
	}

	const processedRangeOrders: Position[][] = await Promise.all(
		[true, false].map((isCall) =>
			processOptionType(isCall, maturityString, market, maturityTimestamp),
		),
	)
	log.debug(
		`Processed Maturity: ${JSON.stringify(
			flatten(processedRangeOrders),
			null,
			4,
		)}`,
	)
	return flatten(processedRangeOrders)
}

async function processOptionType(
	isCall: boolean,
	maturityString: string,
	market: string,
	maturityTimestamp: number,
) {
	//NOTE: we know there are strikes as we hydrated it in hydrateStrikes()
	const strikes = isCall
		? marketParams[market].callStrikes!
		: marketParams[market].putStrikes!
	const strikesBigInt = strikes.map((strike) => parseEther(strike.toString()))

	const processedRangeOrders: Position[][] = await Promise.all(
		strikesBigInt.map(
			async (strike) =>
				await processStrike(
					strike,
					isCall,
					maturityString,
					market,
					maturityTimestamp,
				),
		),
	)
	log.debug(
		`Processed OptionType: ${JSON.stringify(
			flatten(processedRangeOrders),
			null,
			4,
		)}`,
	)
	return flatten(processedRangeOrders)
}

async function processStrike(
	strike: bigint,
	isCall: boolean,
	maturityString: string,
	market: string,
	maturityTimestamp: number,
) {
	const poolKey: PoolKey = {
		base: marketParams[market].address,
		quote: addresses.tokens.USDC,
		oracleAdapter: addresses.core.ChainlinkAdapterProxy.address,
		strike,
		maturity: maturityTimestamp,
		isCallPool: isCall,
	}

	/*
	NOTE: this is here for contract upgrades that could cause issues with getting
	old pools that already exist.
	 */
	let poolAddress: string
	let isDeployed: boolean
	try {
		;[poolAddress, isDeployed] = await poolFactory.getPoolAddress(poolKey)

		if (!isDeployed) {
			log.warning(
				`Pool is not deployed ${market}-${maturityString}-${formatEther(
					strike,
				)}-${isCall ? 'C' : 'P'}`,
			)
			return []
		}
	} catch {
		log.warning(
			`Can not get poolAddress ${market}-${maturityString}-${formatEther(
				strike,
			)}-${isCall ? 'C' : 'P'}`,
		)
		return []
	}

	const pool = premia.contracts.getPoolContract(
		poolAddress,
		botMultiCallProvider,
	)

	let tokenIds: bigint[]

	try {
		tokenIds = (await pool.tokensByAccount(lpAddress)).filter(
			(tokenId) => tokenId > 2n,
		)
	} catch {
		log.warning(
			`No balance query for ${market}-${maturityString}-${formatEther(
				strike,
			)}-${isCall ? 'C' : 'P'}`,
		)
		return []
	}

	if (tokenIds.length > 0) {
		log.info(
			`Existing positions for ${maturityString}-${strike}-${
				isCall ? 'C' : 'P'
			}: ${tokenIds.length}`,
		)

		log.debug(
			`Existing positions token ids (${maturityString}-${strike}-${
				isCall ? 'C' : 'P'
			}): `,
			tokenIds,
		)
	}

	const processedRangeOrders: Position[] = await processTokenIds(
		tokenIds,
		pool,
		maturityString,
		strike,
		isCall,
		market,
		poolAddress,
	)

	log.debug(
		`Processed Strike: ${JSON.stringify(
			flatten(processedRangeOrders),
			null,
			4,
		)}`,
	)
	return processedRangeOrders
}

async function processTokenIds(
	tokenIds: bigint[],
	pool: IPool,
	maturityString: string,
	strike: bigint,
	isCall: boolean,
	market: string,
	poolAddress: string,
) {
	const lpRangeOrders: Position[] = []
	await Promise.all(
		tokenIds.map(async (tokenId) => {
			const positionKey = parseTokenId(tokenId)
			const lpTokenBalance = parseFloat(
				formatEther(await pool.balanceOf(lpAddress, tokenId)),
			)

			if (lpTokenBalance > 0) {
				const position: Position = {
					market,
					posKey: {
						owner: lpAddress,
						operator: positionKey.operator,
						lower: formatEther(positionKey.lower),
						upper: formatEther(positionKey.upper),
						orderType: positionKey.orderType,
					},
					depositSize: lpTokenBalance,
					poolAddress,
					strike: Number(formatEther(strike)),
					maturity: maturityString,
					isCall: isCall,
				}

				lpRangeOrders.push(position)
			}
		}),
	)
	return lpRangeOrders
}

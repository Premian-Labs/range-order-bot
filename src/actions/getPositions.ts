import { IPool, PoolKey } from '@premia/v3-sdk'
import { parseEther, formatEther } from 'ethers'
import { marketParams } from '../config'
import { lpAddress, addresses } from '../config/constants'
import { Position } from '../utils/types'
import { createExpiration, getLast30Days, nextYearOfMaturities } from '../utils/dates'
import { premia } from '../config/contracts'
import { parseTokenId } from '../utils/tokens'
import { log } from '../utils/logs'
import { calculatePoolAddress } from '../utils/pools'

// NOTE: this will find ALL range orders by user (not just from the bot)
// IMPORTANT: can ONLY be run if BOTH call/put strikes exist in marketParams
export async function getExistingPositions(market: string) {
	let lpRangeOrders: Position[] = []

	log.info(`Getting existing positions for: ${market}`)

	try {
		const maturities = [...getLast30Days(), ...nextYearOfMaturities()].map(
			// NOTE: maturity now follows "03NOV23" string format
			(maturity) => maturity.format('DDMMMYY'),
		)

		await Promise.all(
			maturities.map((maturityString) =>
				processMaturity(maturityString, market, lpRangeOrders),
			),
		)

		log.info(`Finished getting existing positions!`)
		log.info(`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`)
	} catch (err) {
		log.error(`Error getting existing positions: ${err}`)
		log.debug(`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`)
	}

	// NOTE: lpRangeOrders array is populated in the last function call => processTokenIds ()
	return lpRangeOrders
}

async function processMaturity(
	maturityString: string,
	market: string,
	lpRangeOrders: Position[],
) {
	let maturityTimestamp: number

	try {
		maturityTimestamp = createExpiration(maturityString)
	} catch {
		log.error(`Invalid maturity: ${maturityString}`)
		return
	}

	await Promise.all(
		[true, false].map((isCall) =>
			processOptionType(
				isCall,
				maturityString,
				market,
				maturityTimestamp,
				lpRangeOrders,
			),
		),
	)
}

async function processOptionType(
	isCall: boolean,
	maturityString: string,
	market: string,
	maturityTimestamp: number,
	lpRangeOrders: Position[],
) {
	//NOTE: we know there are strikes as we hydrated it in hydrateStrikes()
	const strikes = isCall
		? marketParams[market].callStrikes!
		: marketParams[market].putStrikes!
	const strikesBigInt = strikes.map((strike) => parseEther(strike.toString()))

	await Promise.all(
		strikesBigInt.map((strike) =>
			processStrike(
				strike,
				isCall,
				maturityString,
				market,
				maturityTimestamp,
				lpRangeOrders,
			),
		),
	)
}

async function processStrike(
	strike: bigint,
	isCall: boolean,
	maturityString: string,
	market: string,
	maturityTimestamp: number,
	lpRangeOrders: Position[],
) {
	const poolKey: PoolKey = {
		base: marketParams[market].address,
		quote: addresses.tokens.USDC,
		oracleAdapter: addresses.core.ChainlinkAdapterProxy.address,
		strike,
		maturity: maturityTimestamp,
		isCallPool: isCall,
	}

	log.debug(
		`Checking Balance for: ${maturityString}-${formatEther(strike)}-${
			isCall ? 'C' : 'P'
		}`,
	)

	/*
	NOTE: this is here for contract upgrades that could cause issues with getting
	old pools that already exist.
	 */
	let poolAddress: string
	// TODO: does getPoolAddress tell us if its deployed? If so, we can just return here
	try {
		poolAddress = await premia.pools.getPoolAddress(poolKey)
	} catch {
		poolAddress = calculatePoolAddress(poolKey)
	}

	const pool = premia.contracts.getPoolContract(
		poolAddress,
		premia.multicallProvider as any,
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
		return
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

	await processTokenIds(
		tokenIds,
		pool,
		maturityString,
		strike,
		isCall,
		market,
		poolAddress,
		lpRangeOrders,
	)
}

async function processTokenIds(
	tokenIds: bigint[],
	pool: IPool,
	maturityString: string,
	strike: bigint,
	isCall: boolean,
	market: string,
	poolAddress: string,
	lpRangeOrders: Position[],
) {
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
}

import { IPool, PoolKey, nextYearOfMaturities } from '@premia/v3-sdk'
import { parseEther, formatEther } from 'ethers'
import { marketParams } from '../config'
import { lpAddress, addresses } from '../constants'
import { Position } from '../types'
import { createExpiration, getLast30Days } from '../utils/dates'
import { premia } from '../contracts'
import { parseTokenId } from '../utils/tokens'
import { log } from '../utils/logs'
import { calculatePoolAddress } from '../utils/pools'

// NOTE: this will find ALL range orders by user (not just from the bot)
export async function getExistingPositions(market: string, spotPrice: number) {
	let lpRangeOrders: Position[] = []

	log.info(`Getting existing positions for: ${market}`)

	try {
		const maturities = [...getLast30Days(), ...nextYearOfMaturities()].map(
			// NOTE: maturity now follows "03NOV23" string format
			(maturity) => maturity.format('DDMMMYY'),
		)

		await Promise.all(
			maturities.map((maturityString) =>
				processMaturity(maturityString, market, spotPrice, lpRangeOrders),
			),
		)

		log.info(`Finished getting existing positions!`)
		log.debug(`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`)
	} catch (e) {
		log.error(`Error getting existing positions: ${e}`)
		log.debug(`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`)
	}

	// NOTE: lpRangeOrders array is populated in the last function call => processTokenIds ()
	return lpRangeOrders
}

async function processMaturity(
	maturityString: string,
	market: string,
	spotPrice: number,
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
				spotPrice,
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
	spotPrice: number,
	maturityTimestamp: number,
	lpRangeOrders: Position[],
) {
	// TODO: what comes back if spot price input is undefined?
	const strikes = premia.options.getSuggestedStrikes(
		parseEther(spotPrice.toString()),
	)

	await Promise.all(
		strikes.map((strike) =>
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
		`Checking: ${maturityString}-${formatEther(strike)}-${isCall ? 'C' : 'P'}`,
	)

	let poolAddress: string

	// TODO: Why even attempt to get poolAddress if we can calculate it?
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
		//TODO: should we be logging this as an issue (make note of which market)?
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

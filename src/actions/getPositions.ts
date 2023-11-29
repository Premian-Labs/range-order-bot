import { IPool, PoolKey } from '@premia/v3-sdk'
import { formatEther, parseEther } from 'ethers'
import moment from 'moment'

import { botMultiCallProvider, poolFactory, premia } from '../config/contracts'
import { addresses, lpAddress } from '../config/constants'
import { marketParams } from '../config'
import { state } from '../config/state'
import { parseTokenId } from '../utils/tokens'
import { Position } from '../utils/types'
import { log } from '../utils/logs'
import {
	createExpiration,
	getLast30Days,
	getTTM,
	nextYearOfMaturities,
} from '../utils/dates'

// NOTE: this will find ALL range orders by user (not just from the bot)
// IMPORTANT: can ONLY be run if BOTH call/put strikes exist in marketParams
export async function getExistingPositions(market: string) {
	log.info(`Getting existing positions for: ${market}`)

	try {
		const maturities = [...getLast30Days(), ...nextYearOfMaturities()].map(
			// NOTE: maturity now follows "03NOV23" string format
			(maturity) => maturity.format('DDMMMYY').toUpperCase(),
		)

		await Promise.all(
			maturities.map((maturityString) =>
				processMaturity(maturityString, market),
			),
		)

		log.info(`Finished getting existing positions!`)
		log.debug(
			`Current LP Positions: ${JSON.stringify(state.lpRangeOrders, null, 4)}`,
		)
	} catch (err) {
		log.error(`Error getting existing positions: ${err}`)
		log.debug(
			`Current LP Positions: ${JSON.stringify(state.lpRangeOrders, null, 4)}`,
		)
	}
}

async function processMaturity(maturityString: string, market: string) {
	let maturityTimestamp: number

	try {
		// 10NOV23 => 1233645758
		maturityTimestamp = createExpiration(maturityString)
	} catch {
		log.error(`Invalid maturity: ${maturityString}`)
		return
	}

	await Promise.all(
		[true, false].map((isCall) =>
			processOptionType(isCall, maturityString, market, maturityTimestamp),
		),
	)
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

	await Promise.all(
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

	let poolAddress: string
	let isDeployed: boolean
	try {
		;[poolAddress, isDeployed] = await poolFactory.getPoolAddress(poolKey)

		if (!isDeployed) {
			log.debug(
				`Pool is not deployed ${market}-${maturityString}-${formatEther(
					strike,
				)}-${isCall ? 'C' : 'P'}. No position to query.`,
			)
			return
		}
	} catch {
		// NOTE: log only if the option has a valid exp but still failed
		const expired = maturityTimestamp < moment.utc().unix()
		const outOfRange = 1 < getTTM(maturityTimestamp)
		if (expired || outOfRange) {
			// No need to attempt to get poolAddress
			return
		} else {
			log.debug(
				`Can not get poolAddress ${market}-${maturityString}-${formatEther(
					strike,
				)}-${isCall ? 'C' : 'P'}`,
			)
			return
		}
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
		return
	}

	if (tokenIds.length > 0) {
		log.info(
			`Existing positions for ${market}-${maturityString}-${Number(
				formatEther(strike),
			)}-${isCall ? 'C' : 'P'}: Total Range Orders: ${tokenIds.length}`,
		)

		log.debug(
			`Existing positions token ids (${market}-${maturityString}-${Number(
				formatEther(strike),
			)}-${isCall ? 'C' : 'P'}): TokenIds: `,
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

				state.lpRangeOrders.push(position)
			}
		}),
	)
}

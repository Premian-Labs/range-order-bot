import { PoolKey, nextYearOfMaturities } from '@premia/v3-sdk'
import { parseEther, formatEther } from 'ethers'
import { marketParams } from '../config'
import { lpAddress, addresses } from '../constants'
import { Position } from '../types'
import { createExpiration, getLast30Days } from '../utils/dates'
import { premia } from '../contracts'
import { parseTokenId } from '../utils/tokens'
import { log } from '../utils/logs'

export async function getExistingPositions(market: string, spotPrice: number) {
	let lpRangeOrders: Position[] = []

	log.info(`Getting existing positions for: ${market}`)

	try {
		const maturities = [...getLast30Days(), ...nextYearOfMaturities()].map(
			(maturity) => maturity.format('DDMMMYY'),
		)

		await Promise.all(
			maturities.map(async (maturityString) => {
				let maturityTimestamp: number

				try {
					maturityTimestamp = createExpiration(maturityString)
				} catch {
					log.error(`Invalid maturity: ${maturityString}`)
					return
				}

				await Promise.all(
					[true, false].map(async (isCall) => {
						const strikes = premia.options.getSuggestedStrikes(
							parseEther(spotPrice.toString()),
						)

						await Promise.all(
							strikes.map(async (strike) => {
								const poolKey: PoolKey = {
									base: marketParams[market].address,
									quote: addresses.tokens.USDC,
									oracleAdapter: addresses.core.ChainlinkAdapterProxy.address,
									strike,
									maturity: maturityTimestamp,
									isCallPool: isCall,
								}

								log.debug(
									`Checking: ${maturityString}-${formatEther(strike)}-${
										isCall ? 'C' : 'P'
									}`,
								)

								let poolAddress: string

								try {
									poolAddress = await premia.pools.getPoolAddress(poolKey)
								} catch {
									return
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

								await Promise.all(
									tokenIds.map(async (tokenId) => {
										const positionKey = parseTokenId(tokenId)
										const lpTokenBalance = parseFloat(
											formatEther(await pool.balanceOf(lpAddress, tokenId)),
										)

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
									}),
								)

								lpRangeOrders = lpRangeOrders.filter(
									(position) => position.depositSize > 0,
								)
							}),
						)
					}),
				)
			}),
		)

		log.info(`Finished getting existing positions!`)
		log.debug(`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`)
	} catch (e) {
		log.error(`Error getting existing positions: ${e}`)
		log.debug(`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`)
	}

	return lpRangeOrders
}

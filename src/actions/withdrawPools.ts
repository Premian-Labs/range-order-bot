import isEqual from 'lodash.isequal'
import { OrderType, formatTokenId } from '@premia/v3-sdk'
import { parseEther, formatEther } from 'ethers'
import { lpAddress } from '../constants'
import { PosKey, Position } from '../types'
import { premia, provider } from '../contracts'
import { getCurrentTimestamp } from '../utils/dates'
import { log } from '../utils/logs'

export async function withdrawSettleLiquidity(
	lpRangeOrders: Position[],
	market: string,
) {
	log.app(`Withdrawing liquidity from ${market}`)

	const filteredRangeOrders = lpRangeOrders.filter((rangeOrder: Position) => {
		return rangeOrder.market === market
	})

	// if there is no withdraw to process
	if (filteredRangeOrders.length === 0) {
		log.info(`No existing positions for ${market}`)
		return lpRangeOrders
	}

	/// @dev: no point parallelizing this since we need to wait for each tx to confirm
	///		  with a better nonce manager, this would not be necessary since withdrawals
	///		  are independent of each other
	for (const filteredRangeOrder of filteredRangeOrders) {
		log.info(
			`Processing withdraw for size: ${filteredRangeOrder.depositSize} in ${
				filteredRangeOrder.market
			} ${filteredRangeOrder.maturity}-${filteredRangeOrder.strike}-${
				filteredRangeOrder.isCall ? 'C' : 'P'
			} (${
				filteredRangeOrder.posKey.orderType == OrderType.LONG_COLLATERAL
					? 'LC'
					: 'CS'
			})`,
		)
		log.debug(
			`Processing withdraw for: ${JSON.stringify(filteredRangeOrder, null, 4)}`,
		)

		const pool = premia.contracts.getPoolContract(
			filteredRangeOrder.poolAddress,
			premia.multicallProvider as any,
		)
		const posKey: PosKey = {
			owner: filteredRangeOrder.posKey.owner,
			operator: filteredRangeOrder.posKey.operator,
			lower: parseEther(filteredRangeOrder.posKey.lower),
			upper: parseEther(filteredRangeOrder.posKey.upper),
			orderType: filteredRangeOrder.posKey.orderType,
		}
		const tokenId = formatTokenId({
			version: 1,
			operator: lpAddress!,
			lower: posKey.lower,
			upper: posKey.upper,
			orderType: posKey.orderType,
		})

		const [poolSettings, poolBalance] = await Promise.all([
			pool.getPoolSettings(),
			pool.balanceOf(lpAddress, tokenId),
		])

		const lpTokenBalance = parseFloat(formatEther(poolBalance))

		log.info('Withdrawing LP Token Balance: ', lpTokenBalance)

		// we can not withdraw a zero balance
		if (lpTokenBalance == 0) {
			log.warning(`Can not withdraw or settle. No position balance.`)
			// remove range order from array no action can be taken now or later
			lpRangeOrders = lpRangeOrders.filter(
				(rangeOrder) => !isEqual(rangeOrder, filteredRangeOrder),
			)
			continue
		}

		try {
			// Use signer from now on, instead of multicall, to execute transactions
			const executablePool = premia.contracts.getPoolContract(
				filteredRangeOrder.poolAddress,
				premia.signer as any,
			)

			// If pool expired attempt to settle position and ignore withdraw attempt
			const exp = Number(poolSettings[4])
			if (exp < getCurrentTimestamp()) {
				log.info(`Pool expired. Settling position instead...`)

				const settlePositionTx = await executablePool.settlePosition(posKey)

				const confirm = await provider.waitForTransaction(
					settlePositionTx.hash,
					1,
				)

				if (confirm?.status == 0) {
					log.warning(`No settlement of LP Range Order`)
					log.warning(confirm)
					continue
				}

				// remove range order from array if settlement is successful
				lpRangeOrders = lpRangeOrders.filter(
					(rangeOrder) => !isEqual(rangeOrder, filteredRangeOrder),
				)
				log.info(`LP Range Order settlement confirmed.`)
			} else {
				const withdrawTx = await executablePool.withdraw(
					posKey,
					parseEther(lpTokenBalance.toString()),
					0,
					parseEther('1'),
					// { gasLimit: 1400000 },
				)

				const confirm = await provider.waitForTransaction(withdrawTx.hash, 1)

				if (confirm?.status == 0) {
					log.warning(`Failed withdrawal of LP Range Order`)
					log.warning(confirm)
					continue
				}

				// remove range order from array if withdraw is sucesseful
				lpRangeOrders = lpRangeOrders.filter(
					(rangeOrder) => !isEqual(rangeOrder, filteredRangeOrder),
				)
				log.info(`LP Range Order withdraw confirmed of size: ${lpTokenBalance}`)
			}

			log.info(`Finished withdrawing or settling position.`)
			log.debug(
				`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`,
			)
		} catch (err) {
			log.error(`Error withdrawing LP Range Order: ${err}`)
			log.debug(
				`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`,
			)
		}
	}

	return lpRangeOrders
}

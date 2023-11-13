import isEqual from 'lodash.isequal'
import { IPool, OrderType, formatTokenId } from '@premia/v3-sdk'
import { parseEther, formatEther } from 'ethers'
import { lpAddress } from '../constants'
import { PosKey, Position } from '../types'
import { premia, provider } from '../contracts'
import { log } from '../utils/logs'
import { delay } from '../utils/time'
import moment from 'moment/moment'

// NOTE: This will only withdraw positions in lpRangeOrders
export async function withdrawSettleLiquidity(
	lpRangeOrders: Position[],
	market: string,
) {
	log.app(`Withdrawing liquidity from ${market}`)

	// TODO: Isn't the lpRangOrders array market specific?
	const filteredRangeOrders = lpRangeOrders.filter((rangeOrder: Position) => {
		return rangeOrder.market === market
	})

	// TODO: what scenario does this happen? Manual withdraw between updates?
	// if there is no withdraw to process
	if (filteredRangeOrders.length === 0) {
		log.info(`No existing positions for ${market}`)
		return lpRangeOrders
	}

	/*
		@dev: no point process parallel tx this since we need to wait for each tx to confirm
		with a better nonce manager, this would not be necessary since withdrawals
		are independent of each other
	 */
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

		//NOTE: Position type (filteredRangeOrder) uses SerializedPosKey type
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

		// TODO: isn't this promise.all() just a single pool balance request?
		// FIXME: how do we handle failure case here? possible dupe order edge case
		/*
		PoolSettings => [ base, quote, oracleAdapter, strike, maturity, isCallPool ]
		 */
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

		// FIXME: where is the catch block?
		try {
			// Use signer from now on, instead of multicall, to execute transactions
			const executablePool = premia.contracts.getPoolContract(
				filteredRangeOrder.poolAddress,
				premia.signer as any,
			)

			// If pool expired attempt to settle position and ignore withdraw attempt
			const exp = Number(poolSettings[4])

			// TODO: what is the catch block if this throws We do not want to remove from lpRangeOrders?
			await withdrawPosition(executablePool, posKey, poolBalance, exp)

			// remove range order from array if settlement is successful
			lpRangeOrders = lpRangeOrders.filter(
				(rangeOrder) => !isEqual(rangeOrder, filteredRangeOrder),
			)

			log.info(`Finished withdrawing or settling position.`)
		} finally {
			log.debug(
				`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`,
			)
		}
	}

	return lpRangeOrders
}

async function withdrawPosition(
	executablePool: IPool,
	posKey: PosKey,
	poolBalance: bigint,
	exp: number,
	retry: boolean = true,
) {
	if (exp < moment.utc().unix()) {
		log.info(`Pool expired. Settling position instead...`)

		try {
			const settlePositionTx = await executablePool.settlePosition(posKey)
			const confirm = await settlePositionTx.wait(1)

			if (confirm?.status == 0) {
				log.warning(`No settlement of LP Range Order`)
				log.warning(confirm)
				// FIXME: if we just terminate here, it appears we remove the position from lpRangeOrders next
				// TODO: shouldn't we throw here instead?
				return
			}

			log.info(`LP Range Order settlement confirmed.`)
		} catch (err) {
			await delay(2000)

			if (retry) {
				return withdrawPosition(executablePool, posKey, poolBalance, exp, false)
			} else {
				log.error(`Error settling LP Range Order: ${err}`)
				throw err
			}
		}
	}

	try {
		const withdrawTx = await executablePool.withdraw(
			posKey,
			poolBalance.toString(),
			0,
			parseEther('1'),
			// { gasLimit: 1400000 },
		)

		// TODO: would it be better to just use wait() to stay consistent?
		const confirm = await provider.waitForTransaction(withdrawTx.hash, 1)

		if (confirm?.status == 0) {
			throw new Error(
				`Failed to confirm withdrawal of LP Range Order: ${confirm}`,
			)
		}

		log.info(`LP Range Order withdraw confirmed of size: ${poolBalance}`)
	} catch (err) {
		await delay(2000)

		if (retry) {
			return withdrawPosition(executablePool, posKey, poolBalance, exp, false)
		} else {
			log.error(`Error withdrawing LP Range Order: ${err}`)
			throw err
		}
	}
}

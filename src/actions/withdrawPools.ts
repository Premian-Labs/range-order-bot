// noinspection ExceptionCaughtLocallyJS

import isEqual from 'lodash.isequal'
import { IPool, OrderType, formatTokenId } from '@premia/v3-sdk'
import { parseEther, formatEther } from 'ethers'
import { lpAddress } from '../config/constants'
import { PosKey, Position } from '../utils/types'
import { botMultiCallProvider, premia } from '../config/contracts'
import { log } from '../utils/logs'
import { delay } from '../utils/time'
import moment from 'moment/moment'
import { state } from '../config'

// NOTE: This will only withdraw positions in state.lpRangeOrders
export async function withdrawSettleLiquidity(market: string) {
	log.app(`Attempting to withdraw liquidity from ${market}`)

	const withdrawableOptions = state.optionParams.filter((option) => {
		return option.withdrawable && option.market === market
	})

	// end early if there is no withdraws to process
	if (withdrawableOptions.length === 0) {
		log.info(`No withdrawable positions for ${market} exist`)
		return
	}

	const filteredRangeOrders = state.lpRangeOrders.filter(
		(rangeOrder: Position) => {
			return rangeOrder.market === market
		},
	)

	/*
		@dev: no point to process parallel txs since we need to wait for each tx to confirm.
		With a better nonce manager, this would not be necessary since withdrawals
		are independent of each other
	 */
	for (const filteredRangeOrder of filteredRangeOrders) {
		const withdrawable = await checkWithdrawStatus(filteredRangeOrder)

		// skip lpRangeOrder if not withdrawable
		if (!withdrawable) {
			continue
		}

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
			operator: lpAddress,
			lower: posKey.lower,
			upper: posKey.upper,
			orderType: posKey.orderType,
		})

		const pool = premia.contracts.getPoolContract(
			filteredRangeOrder.poolAddress,
			botMultiCallProvider,
		)

		/*
		PoolSettings array => [ base, quote, oracleAdapter, strike, maturity, isCallPool ]
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
			// TODO: remove range order from array
			state.lpRangeOrders = state.lpRangeOrders.filter(
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

			const exp = Number(poolSettings[4])

			await withdrawPosition(executablePool, posKey, poolBalance, exp)

			// remove range order from array if withdraw/settle is successful
			// TODO: remove range order from array
			state.lpRangeOrders = state.lpRangeOrders.filter(
				(rangeOrder) => !isEqual(rangeOrder, filteredRangeOrder),
			)

			log.info(`Finished withdrawing or settling position.`)
		} catch (err) {
			log.warning(
				`Attempt to withdraw failed: ${JSON.stringify(filteredRangeOrder)}`,
			)
		} finally {
			log.debug(
				`Current LP Positions: ${JSON.stringify(state.lpRangeOrders, null, 4)}`,
			)
		}
	}

	return state.lpRangeOrders
}

async function checkWithdrawStatus(lpRangeOrder: Position) {
	// NOTE: Find option using market/maturity/type/strike (should only be one)
	const optionIndex = state.optionParams.findIndex(
		(option) =>
			option.market === lpRangeOrder.market &&
			option.maturity === lpRangeOrder.maturity &&
			option.type === (lpRangeOrder.isCall ? 'C' : 'P') &&
			option.strike === lpRangeOrder.strike &&
			option.withdrawable,
	)

	// IMPORTANT: -1 is returned if lpRangeOrder is not in state.optionParams.  If this is the case there is a bug
	if (optionIndex == -1) {
		log.debug(`lpRangeOrder: ${JSON.stringify(lpRangeOrder, null, 4)}`)
		log.debug(
			`state.optionParams:: ${JSON.stringify(state.optionParams, null, 4)}`,
		)
		throw new Error(
			'lpRangeOrder was not traceable in state.optionParams. Please contact dev team',
		)
	}

	// On oracle failure cases we withdraw all withdrawable positions
	if (
		state.optionParams[optionIndex].ivOracleFailure ||
		state.optionParams[optionIndex].spotOracleFailure
	) {
		log.warning(
			`Withdrawing ${lpRangeOrder.market}-${lpRangeOrder.maturity}-${
				lpRangeOrder.strike
			}-${lpRangeOrder.isCall ? 'C' : 'P'} due to oracle failure`,
		)
		return true
	}

	// So long as cycleOrders is true at this point, we can process withdraw
	return state.optionParams[optionIndex].cycleOrders
}

async function withdrawPosition(
	executablePool: IPool,
	posKey: PosKey,
	poolBalance: bigint,
	exp: number,
	retry: boolean = true,
) {
	// If pool expired attempt to settle position and ignore withdraw attempt
	if (exp < moment.utc().unix()) {
		log.info(`Pool expired. Settling position instead...`)

		try {
			const settlePositionTx = await executablePool.settlePosition(posKey)
			const confirm = await settlePositionTx.wait(1)

			if (confirm?.status == 0) {
				throw new Error(
					`Failed to confirm settlement of LP Range Order ${confirm}`,
				)
			}

			log.info(`LP Range Order settlement confirmed.`)
			return
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
			{ gasLimit: 1400000 },
		)

		const confirm = await withdrawTx.wait(1)

		if (confirm?.status == 0) {
			throw new Error(
				`Failed to confirm withdrawal of LP Range Order: ${confirm}`,
			)
		}

		log.info(
			`LP Range Order withdraw confirmed of size: ${formatEther(poolBalance)}`,
		)
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

import * as fs from 'fs'
import moment from 'moment/moment'
import {
	JsonRpcProvider,
	parseEther,
	Wallet,
	formatEther,
	ContractTransactionResponse,
	TransactionReceipt,
} from 'ethers'
import { IPool__factory } from '../../typechain'
import { useRangeOrderBalance } from '../config/liquiditySettings'
import { privateKey, rpcUrl, lpAddress } from '../config/constants'
import { delay, formatTokenId } from './utils'
import { PosKey, Position } from '../types'
import isEqual from 'lodash.isequal'

const provider = new JsonRpcProvider(rpcUrl)
const signer = new Wallet(privateKey!, provider)

const ts = moment.utc().unix()

export async function withdrawSettleLiquidity(
	lpRangeOrders: Position[],
	market: string,
) {
	const filteredRangeOrders = lpRangeOrders.filter((rangeOrder: Position) => {
		return rangeOrder.market === market
	})

	// if there is no withdraw to process
	if (filteredRangeOrders.length === 0) {
		console.log(`No existing positions for ${market}`)
		return lpRangeOrders
	}

	for (const filteredRangeOrder of filteredRangeOrders) {
		console.log(
			`\n`,
			`\n`,
			`Processing withdraw for ${JSON.stringify(filteredRangeOrder, null, 4)}`,
		)

		const pool = IPool__factory.connect(filteredRangeOrder.poolAddress, signer)
		const posKey: PosKey = {
			owner: filteredRangeOrder.posKey.owner,
			operator: filteredRangeOrder.posKey.operator,
			lower: parseEther(filteredRangeOrder.posKey.lower),
			upper: parseEther(filteredRangeOrder.posKey.upper),
			orderType: filteredRangeOrder.posKey.orderType,
		}

		const poolSettings = await pool.getPoolSettings()
		const exp = Number(poolSettings[4])

		const tokenId = formatTokenId({
			version: 1,
			operator: lpAddress!,
			lower: posKey.lower,
			upper: posKey.upper,
			orderType: posKey.orderType,
		})

		const lpTokenBalance = parseFloat(
			formatEther(await pool.balanceOf(lpAddress!, tokenId)),
		)

		const withdrawSize = useRangeOrderBalance
			? lpTokenBalance
			: filteredRangeOrder.depositSize

		console.log('LP Token Balance: ', lpTokenBalance)

		// we can not withdraw more than we own
		if (
			lpTokenBalance < filteredRangeOrder.depositSize &&
			!useRangeOrderBalance
		) {
			console.log(
				`WARNING: Can not withdraw or settle. Position balance is smaller than depositSize`,
			)
			continue
		}

		// we can not withdraw a zero balance
		if (lpTokenBalance == 0) {
			console.log(`WARNING: Can not withdraw or settle. No position balance`)
			// remove range order from array no action can be taken now or later
			lpRangeOrders = lpRangeOrders.filter(
				(rangeOrder) => !isEqual(rangeOrder, filteredRangeOrder),
			)
			continue
		}

		// If pool expired attempt to settle position and ignore withdraw attempt
		if (exp < ts) {
			console.log(`Pool expired...settling position instead...`)

			let settlePositionTx: ContractTransactionResponse
			let confirm: TransactionReceipt | null

			try {
				settlePositionTx = await pool.settlePosition(posKey)

				confirm = await settlePositionTx.wait(1)
			} catch (e) {
				await delay(2000)
				try {
					settlePositionTx = await pool.settlePosition(posKey)

					confirm = await settlePositionTx.wait(1)
				} catch (e) {
					console.log(`WARNING: unable to settle position`)
					console.log(e)
					confirm = null
				}
			}

			// NOTE: issues beyond a provider error are covered here
			if (confirm?.status == 0) {
				console.log(`WARNING: No settlement of LP Range Order`)
				console.log(confirm)
				continue
			}

			// Successful transaction
			if (confirm?.status == 1) {
				console.log(`LP Range Order settlement confirmed!`)
				// remove range order from array if settlement is successful
				lpRangeOrders = lpRangeOrders.filter(
					(rangeOrder) => !isEqual(rangeOrder, filteredRangeOrder),
				)
				continue
			}
		}

		let withdrawTx: ContractTransactionResponse
		let confirm: TransactionReceipt | null

		try {
			withdrawTx = await pool.withdraw(
				posKey,
				parseEther(withdrawSize.toString()),
				0,
				parseEther('1'),
				{ gasLimit: 10000000 },
			)
			confirm = await withdrawTx.wait(1)
		} catch (e) {
			await delay(2000)
			try {
				withdrawTx = await pool.withdraw(
					posKey,
					parseEther(withdrawSize.toString()),
					0,
					parseEther('1'),
					{ gasLimit: 10000000 },
				)
				confirm = await withdrawTx.wait(1)
			} catch (e) {
				console.log(`WARNING: unable to withdraw position!`)
				console.log(e)
				confirm = null
			}
		}

		// NOTE: issues beyond a provider error are covered here
		if (confirm?.status == 0) {
			console.log(`WARNING: No withdraw of LP Range Order`)
			console.log(confirm)
			continue
		}

		// Successful transaction
		if (confirm?.status == 1) {
			console.log(`Withdraw successful!`)
			lpRangeOrders = lpRangeOrders.filter(
				(rangeOrder) => !isEqual(rangeOrder, filteredRangeOrder),
			)
			console.log(
				`LP Range Order withdraw confirmed of size : ${withdrawSize}!`,
			)
		}
	}
	console.log(`Finished withdraw and/or settling of positions!`)
	console.log(`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`)
	fs.writeFileSync(
		'./src/config/lpPositions.json',
		JSON.stringify({ lpRangeOrders }),
	)
	return lpRangeOrders
}

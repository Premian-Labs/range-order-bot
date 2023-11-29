import {
	MIN_TICK_DISTANCE,
	OrderType,
	TokenIdParams,
} from '@premia/v3-sdk'
import { MaxUint256, getAddress } from 'ethers'

import {premia, signerAddress} from '../config/contracts'
import { addresses } from '../config/constants'
import { delay } from './time'
import { log } from './logs'
import {marketParams} from "../config";

export async function setApproval(
	market: string,
	collateralValue: bigint,
	retry: boolean = true,
) {
	const tokenAddress = market === 'USDC'? addresses.tokens.USDC : marketParams[market].address
	const token = premia.contracts.getTokenContract(
		tokenAddress,
		premia.signer as any,
	)

	try {
		const allowance = await token.allowance(
			signerAddress,
			addresses.core.ERC20Router.address,
		)

		if (allowance >= collateralValue) {
			return
		}

		if (collateralValue === MaxUint256) {
			return token.approve(
				addresses.core.ERC20Router.address,
				MaxUint256.toString(),
			)
		}

		const approveTX = await token.approve(
			addresses.core.ERC20Router.address,
			collateralValue,
		)
		const confirm = await approveTX.wait(1)

		if (confirm?.status == 0) {
			throw new Error(`Failed to confirm approval set: ${confirm}`)
		}
	} catch (err) {
		await delay(2000)
		if (retry) {
			return setApproval(market, collateralValue, false)
		} else {
			log.error(
				`Approval could not be set for ${await token.symbol()}! Try again or check provider and ETH balance...`,
			)
			throw err
		}
	}
}

export function parseTokenId(tokenId: bigint): TokenIdParams {
	const version = tokenId >> 252n
	const orderType = Number((tokenId >> 180n) & 0xfn)
	const operator = getAddress(
		String(
			'0x' + ((tokenId >> 20n) & BigInt('0x' + 'ff'.repeat(20))).toString(16),
		),
	)
	const upper = ((tokenId >> 10n) & 0x3ffn) * MIN_TICK_DISTANCE
	const lower = (tokenId & 0x3ffn) * MIN_TICK_DISTANCE

	return {
		version: Number(version),
		orderType: orderType as OrderType,
		operator: operator,
		upper: upper,
		lower: lower,
	}
}

import {
	ISolidStateERC20,
	MIN_TICK_DISTANCE,
	OrderType,
	TokenIdParams,
} from '@premia/v3-sdk'
import { MaxUint256, getAddress, toBigInt } from 'ethers'
import { addresses } from '../constants'
import { delay } from './time'
import { log } from './logs'
import { signerAddress } from '../contracts'

export async function setApproval(
	collateralValue: bigint,
	token: ISolidStateERC20,
	retry: boolean = true,
) {
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
			return setApproval(collateralValue, token, false)
		} else {
			log.error(
				`Approval could not be set for ${await token.symbol()}! Try again or check provider and ETH balance...`,
			)
			throw err
		}
	}
}

export function formatTokenId({
	version,
	operator,
	lower,
	upper,
	orderType,
}: TokenIdParams) {
	let tokenId = toBigInt(version ?? 0) << 252n
	tokenId = tokenId + (toBigInt(orderType.valueOf()) << 180n)
	tokenId = tokenId + (toBigInt(operator) << 20n)
	tokenId = tokenId + ((toBigInt(upper) / MIN_TICK_DISTANCE) << 10n)
	tokenId = tokenId + toBigInt(lower) / MIN_TICK_DISTANCE

	return tokenId
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

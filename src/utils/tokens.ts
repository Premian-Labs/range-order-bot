import {
	ISolidStateERC20,
	MIN_TICK_DISTANCE,
	OrderType,
	TokenIdParams,
} from '@premia/v3-sdk'
import { MaxUint256, getAddress, parseUnits, toBigInt } from 'ethers'
import { addresses } from '../constants'
import { delay } from './time'
import { log } from './logs'

export async function setApproval(
	collateralValue: number,
	token: ISolidStateERC20,
	retry: boolean = true,
) {
	try {
		if (collateralValue === Number(MaxUint256)) {
			return token.approve(
				addresses.core.ERC20Router.address,
				MaxUint256.toString(),
			)
		}

		const decimals = Number(await token.decimals())
		const mantissa = 10 ** decimals
		const approvalAmount = parseUnits(
			(Math.ceil(collateralValue * mantissa) / mantissa).toString(),
			decimals,
		)

		return token.approve(addresses.core.ERC20Router.address, approvalAmount)
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

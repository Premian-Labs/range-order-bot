import {
	ISolidStateERC20,
	MIN_TICK_DISTANCE,
	OrderType,
	TokenIdParams,
} from '@premia/v3-sdk'
import { getAddress, parseUnits, toBigInt } from 'ethers'
import { addresses } from '../constants'

export async function setApproval(
	collateralValue: number,
	token: ISolidStateERC20,
) {
	const decimals = Number(await token.decimals())
	const mantissa = 10 ** decimals
	const approvalAmount = parseUnits(
		(Math.ceil(collateralValue * mantissa) / mantissa).toString(),
		decimals,
	)

	return token.approve(addresses.core.ERC20Router.address, approvalAmount)
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

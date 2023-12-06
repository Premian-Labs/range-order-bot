import { MIN_TICK_DISTANCE, OrderType, TokenIdParams } from '@premia/v3-sdk'
import { getAddress } from 'ethers'

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

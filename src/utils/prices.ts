import { formatEther } from 'ethers'
import { chainlink } from '../contracts'
import { marketParams } from '../config'
import { addresses } from '../constants'
import { delay } from './time'
import { log } from './logs'

export async function getSpotPrice(market: string, retry: boolean = true) {
	try {
		return parseFloat(
			formatEther(
				await chainlink.getPrice(
					marketParams[market].address,
					addresses.tokens.USDC,
				),
			),
		)
	} catch (e) {
		await delay(2000)

		if (retry) {
			return getSpotPrice(market, false)
		} else {
			log.warning(
				`Failed to get current price for ${market}. \n
                If issue persists, please check node provider`,
			)
		}
	}

	return undefined
}

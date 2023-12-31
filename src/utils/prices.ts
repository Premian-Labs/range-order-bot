import { formatEther } from 'ethers'
import { chainlink } from '../config/contracts'
import { marketParams } from '../config'
import { addresses } from '../config/constants'
import { delay } from './time'
import { log } from './logs'

/*
 @dev: potentially use coingecko API price as backup to chainlink oracle
 */
export async function getSpotPrice(market: string, retry: boolean = true) {
	try {
		return parseFloat(
			formatEther(
				await chainlink.getPrice(
					marketParams[market].address!, //set in getAddresses()
					addresses.tokens.USDC,
				),
			),
		)
	} catch (err) {
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

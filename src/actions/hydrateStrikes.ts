import { getSurroundingStrikes } from '../utils/strikes'
import { marketParams } from '../config/index.example'
import { WAD_DECIMALS } from '@premia/v3-sdk'
import { formatEther, parseEther } from 'ethers'

// NOTE: only ran if EITHER strike array is not populated AND we have a spot price for the market
export async function hydrateStrikes(
	market: string,
	decimals: number | bigint = WAD_DECIMALS,
) {
	const spotPrice = marketParams[market].spotPrice

	if (!marketParams[market].callStrikes && spotPrice) {
		marketParams[market].callStrikes = getSurroundingStrikes(
			parseEther(spotPrice!.toString()),
		).map((strike) => {
			return Number(formatEther(strike))
		})
	}

	if (!marketParams[market].putStrikes && spotPrice) {
		marketParams[market].putStrikes = getSurroundingStrikes(
			parseEther(spotPrice!.toString()),
		).map((strike) => {
			return Number(formatEther(strike))
		})
	}

	return
}

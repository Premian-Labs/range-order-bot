import { marketParams } from '../config/liquiditySettings'
import { processStrikes } from './utils'
import { Position } from '../types'
import fs from 'fs'

/*
NOTE: optionally, we can pass in a single market (ie 'WETH') with corresponding spot value
otherwise no inputs will run through ALL markets listed in marketParams.
The market name must match the same format as the key values in MarketParams.
 */
export async function deployLiquidity(
	lpRangeOrders: Position[],
	market: string,
	spotPrice: number,
) {
	console.log(`Deploying liquidity for ${market}`)
	try {
		// within each market loop through each maturity
		for (const maturityString of marketParams[market].maturities) {
			console.log(`Spot Price for ${market}: ${spotPrice}`)
			// within each maturity, process each call strike
			lpRangeOrders = await processStrikes(
				market,
				spotPrice,
				marketParams,
				maturityString,
				true,
				lpRangeOrders,
			)
			// within each maturity, process each put strike
			lpRangeOrders = await processStrikes(
				market,
				spotPrice,
				marketParams,
				maturityString,
				false,
				lpRangeOrders,
			)
		}
	} catch (e) {
		console.log(`${e}`)
		console.log(
			`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`,
		)
		fs.writeFileSync(
			'./src/config/lpPositions.json',
			JSON.stringify({ lpRangeOrders }),
		)
		return lpRangeOrders
	}
	console.log(`All Positions Successfully Processed for ${market}!`)
	console.log(`Current LP Positions: ${JSON.stringify(lpRangeOrders, null, 4)}`)
	fs.writeFileSync(
		'./src/config/lpPositions.json',
		JSON.stringify({ lpRangeOrders }),
	)
	return lpRangeOrders
}

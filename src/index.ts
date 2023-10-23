import { withdrawSettleLiquidity } from './helpers/withdrawPools'
import { deployLiquidity } from './helpers/hydratePools'
import {
	formatEther,
	JsonRpcProvider,
	Wallet,
	MaxUint256,
	ContractTransactionResponse,
	TransactionReceipt,
} from 'ethers'
import moment from 'moment/moment'
import {
	marketParams,
	spotMoveThreshold,
	refreshRate,
	timeThresholdMin,
	withdrawExistingPositions,
	maxCollateralApproved,
} from './config/liquiditySettings'
import { delay } from './helpers/utils'
import { privateKey, rpcUrl, addresses } from './config/constants'
import { IChainlinkAdapter__factory, IERC20__factory } from '../typechain'
import { Position } from './types'
import fs from 'fs'

const provider = new JsonRpcProvider(rpcUrl)
const signer = new Wallet(privateKey!, provider) // NOTE: private key is checked in liquiditySettings.ts
const chainlink = IChainlinkAdapter__factory.connect(
	addresses.core.ChainlinkAdapterProxy.address,
	provider,
)

let lpRangeOrders: Position[] = []
let initialized = false

async function runRangeOrderBot() {
	// Runs once when script begins and check if existing position file is available
	if (!initialized) {
		try {
			const data = fs.readFileSync('./src/config/lpPositions.json', 'utf8')
			lpRangeOrders = JSON.parse(data).lpRangeOrders
		} catch (e) {
			console.log(
				`WARNING: no position file found, a new one will be created...`,
			)
		}
		// Set ALL collateral approvals (base & quote) to max before first deposit cycle
		if (maxCollateralApproved) {
			console.log(`Setting approvals for collateral tokens prior to deposits`)
			// Approvals for call base tokens
			for (const market of Object.keys(marketParams)) {
				const erc20 = IERC20__factory.connect(
					marketParams[market].address,
					signer,
				)

				let response: ContractTransactionResponse
				let confirm: TransactionReceipt | null
				try {
					response = await erc20.approve(
						addresses.core.ERC20Router.address,
						MaxUint256.toString(),
					)
					confirm = await provider.waitForTransaction(response.hash, 1)
				} catch (e) {
					await delay(2000)
					try {
						response = await erc20.approve(
							addresses.core.ERC20Router.address,
							MaxUint256.toString(),
						)
						confirm = await provider.waitForTransaction(response.hash, 1)
					} catch (e) {
						throw new Error(`Max approval could NOT be set for ${market}!`)
					}
				}

				// NOTE: issues beyond a provider error are covered here
				if (confirm?.status == 0) {
					throw new Error(
						`Max approval NOT set for ${market}! Try again or check provider or ETH balance...`,
					)
				}

				// Successful transaction
				console.log(`${market} approval set to MAX`)

			}

			// Approval for quote token
			const erc20 = IERC20__factory.connect(addresses.tokens.USDC, signer)

			let response: ContractTransactionResponse
			let confirm: TransactionReceipt | null
			try {
				response = await erc20.approve(
					addresses.core.ERC20Router.address,
					MaxUint256.toString(),
				)
				confirm = await provider.waitForTransaction(response.hash, 1)
			} catch (e) {
				await delay(2000)
				try {
					response = await erc20.approve(
						addresses.core.ERC20Router.address,
						MaxUint256.toString(),
					)
					confirm = await provider.waitForTransaction(response.hash, 1)
				} catch (e) {
					throw new Error(`Approval could not be set for USDC!`)
				}
			}

			if (confirm?.status == 0) {
				throw new Error(
					`Max approval NOT set for USDC! Try again or check provider or ETH balance...`,
				)
			}

			// Successful transaction
			console.log(`USDC approval set to MAX`)
		}
		initialized = true
	}

	// iterate through each market to determine is liquidity needs to be deployed/updated
	for (const market of Object.keys(marketParams)) {
		/*
    INITIALIZATION CASE: if we have no reference price established for a given market then this is the initial run,
    so we must get price & ts and deploy all orders
    */
		if (!marketParams[market].spotPrice) {
			// get & set spot price
			marketParams[market].spotPrice = parseFloat(
				formatEther(
					await chainlink.getPrice(
						marketParams[market].address,
						addresses.tokens.USDC,
					),
				),
			)
			// set ts
			marketParams[market].ts = moment.utc().unix()

			if (withdrawExistingPositions) {
				lpRangeOrders = await withdrawSettleLiquidity(lpRangeOrders, market)
			}

			// deploy liquidity in given market using marketParam settings
			lpRangeOrders = await deployLiquidity(
				lpRangeOrders,
				market,
				marketParams[market].spotPrice!,
			)
		} else {
			/*
			  MAINTENANCE CASE: if we have a reference price we need to check it against current values and update
			  markets accordingly
			  */

			// get current values
			let ts = moment.utc().unix() // second

			// attempt to get current price (retry if error, and skip on failure)
			let curPrice: number
			try {
				curPrice = parseFloat(
					formatEther(
						await chainlink.getPrice(
							marketParams[market].address,
							addresses.tokens.USDC,
						),
					),
				)
			} catch (e) {
				await delay(5000)
				try {
					curPrice = parseFloat(
						formatEther(
							await chainlink.getPrice(
								marketParams[market].address,
								addresses.tokens.USDC,
							),
						),
					)
				} catch (e) {
					console.log(`WARNING: failed to get current price for ${market}`)
					console.log(`If issue persists, please check node provider`)
					continue
				}
			}

			console.log(`position maintenance process for ${market}`)
			console.log(
				'current price: ',
				curPrice,
				moment.utc().format('YYYY-MM-HH:mm:ss'),
			)

			// All conditional thresholds that trigger an update
			let refPrice = marketParams[market].spotPrice!
			let abovePriceThresh = curPrice > refPrice * (1 + spotMoveThreshold)
			let belowPriceThresh = curPrice < refPrice * (1 - spotMoveThreshold)
			let pastTimeThresh = ts - timeThresholdMin * 60 > marketParams[market].ts!
			// force update if a threshold is reached
			if (abovePriceThresh || belowPriceThresh || pastTimeThresh) {
				console.log('Threshold trigger reached. Updating orders...')
				if (abovePriceThresh) console.log(`Above Price Threshold`)
				if (belowPriceThresh) console.log(`Below Price Threshold`)
				if (pastTimeThresh) console.log(`Time Threshold`)
				// update ref price & ts to latest value
				marketParams[market].spotPrice = curPrice
				marketParams[market].ts = ts
				// remove any liquidity if present
				lpRangeOrders = await withdrawSettleLiquidity(lpRangeOrders, market)
				// deploy liquidity in given market using marketParam settings
				lpRangeOrders = await deployLiquidity(
					lpRangeOrders,
					market,
					marketParams[market].spotPrice!,
				)
			} else {
				console.log(`No update triggered...`)
			}
		}
	}
}

async function main() {
	while (true) {
		await runRangeOrderBot()
		console.log('waiting....')
		await delay(refreshRate * 60 * 1000) // min -> mil
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})

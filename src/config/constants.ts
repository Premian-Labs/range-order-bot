/*
	NOTE: no variables here need to be directly touched. All values are determined by ENV
	variables and constants that exist in the repo.
 */

import dotenv from 'dotenv'
import { arbitrum, arbitrumGoerli } from '@premia/v3-abi/deployment'

dotenv.config()
const { ENV, TESTNET_RPC_URL, MAINNET_RPC_URL, LP_PKEY, LP_ADDRESS } =
	process.env

if (!ENV || !LP_ADDRESS || !LP_PKEY || !MAINNET_RPC_URL || !TESTNET_RPC_URL)
	throw new Error('Missing Env Variables')

// NOTE: we ensure we have the RPC URL, or we throw error (above)
export const rpcUrl = ENV == 'production' ? MAINNET_RPC_URL : TESTNET_RPC_URL

export const privateKey = LP_PKEY
export const lpAddress = LP_ADDRESS

export const addresses = ENV === 'production' ? arbitrum : arbitrumGoerli

export const productionTokenAddr: Record<string, string> = arbitrum.tokens

const productionTokensWithOracles = [
	'WETH',
	'WBTC',
	'ARB',
	'LINK',
	'WSTETH',
	'GMX',
	'MAGIC',
	'SOL',
	'FXS',
]
const developmentTokensWithOracles = ['WETH', 'WBTC', 'LINK']
export const tokensWithOracles =
	ENV === 'production'
		? productionTokensWithOracles
		: developmentTokensWithOracles

export const volatilityOracle = arbitrum.core.VolatilityOracleProxy.address

// the iv oracle is only available on arbitrum mainnet
export const volatilityOracleRpcUrl = MAINNET_RPC_URL

export const SECONDS_IN_YEAR = 365 * 24 * 60 * 60

export const VALID_ORDER_WIDTHS = [
	1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 80, 100, 125, 128, 160, 200,
	250, 256, 320, 400, 500, 512, 625, 640, 800,
]

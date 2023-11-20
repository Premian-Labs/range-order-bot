/*
NOTE: no variables here need to be directly touched. All values are determined by ENV
variables and constants that exist in the repo.
 */
import dotenv from 'dotenv'
import arbAddresses from '@premia/v3-abi/deployment/arbitrum.json'
import arbGoerliAddresses from '@premia/v3-abi/deployment/arbitrumGoerli.json'

dotenv.config()
const { ENV, API_KEY_INFURA, LP_PKEY, LP_ADDRESS } = process.env

if (!ENV || !API_KEY_INFURA || !LP_ADDRESS || !LP_PKEY)
	throw new Error('Missing Env Variables')

export const rpcUrl =
	ENV === 'production'
		? `https://arbitrum-mainnet.infura.io/v3/${API_KEY_INFURA}`
		: `https://arbitrum-goerli.infura.io/v3/${API_KEY_INFURA}`

export const privateKey = LP_PKEY
export const lpAddress = LP_ADDRESS

export const addresses =
	ENV === 'production' ? arbAddresses : arbGoerliAddresses
export const productionTokenAddr: Record<string, string> = arbAddresses.tokens

export const volatilityOracle = arbAddresses.core.VolatilityOracleProxy.address

// the iv oracle is only available on arbitrum mainnet
export const volatilityOracleRpcUrl = `https://arbitrum-mainnet.infura.io/v3/${API_KEY_INFURA}`

export const SECONDS_IN_YEAR = 365 * 24 * 60 * 60

export const VALID_ORDER_WIDTHS = [
	1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 80, 100, 125, 128, 160, 200,
	250, 256, 320, 400, 500, 512, 625, 640, 800,
]

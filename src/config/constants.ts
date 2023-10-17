/*
NOTE: no variables here need to be directly touched. All values are determined by ENV
variables and constants that exist in the repo. The account used
 */
import dotenv from 'dotenv'
import arbAddresses from './arbitrum.json'
import arbGoerliAddresses from './arbitrumGoerli.json'
import { parseEther } from 'ethers'

dotenv.config()
const { ENV, API_KEY_INFURA, LP_PKEY, LP_ADDRESS } = process.env

if (!ENV || !API_KEY_INFURA || !LP_ADDRESS || !LP_PKEY)
	throw new Error('Check Env Variables')
export const rpcUrl =
	ENV === 'production'
		? `https://arbitrum-mainnet.infura.io/v3/${API_KEY_INFURA}`
		: `https://arbitrum-goerli.infura.io/v3/${API_KEY_INFURA}`
export const privateKey = LP_PKEY
export const lpAddress = LP_ADDRESS

export const addresses =
	ENV === 'production' ? arbAddresses : arbGoerliAddresses
export const productionTokenAddr: Record<string, string> = arbAddresses.tokens

//NOTE: Oracle is only available on arbitrum
export const volatilityOracle = arbAddresses.core.VolatilityOracleProxy.address
export const rpcUrlOracle = `https://arbitrum-mainnet.infura.io/v3/${API_KEY_INFURA}`

export const SECONDSINYEAR = 365 * 24 * 60 * 60

export const minTickDistance = parseEther('0.001')

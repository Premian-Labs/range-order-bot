import {
	IPoolFactory__factory,
	IChainlinkAdapter__factory,
	IVolatilityOracle__factory,
	Premia,
} from '@premia/v3-sdk'
import { Wallet, JsonRpcProvider } from 'ethers'
import { MulticallWrapper } from 'ethers-multicall-provider'

import {
	addresses,
	privateKey,
	rpcUrl,
	volatilityOracle,
	volatilityOracleRpcUrl,
} from './constants'

export const premia = Premia.initializeSync({
	provider: rpcUrl,
	privateKey,
})

export const signerAddress = (premia.signer as Wallet).address

export const poolFactory = IPoolFactory__factory.connect(
	addresses.core.PoolFactoryProxy.address,
	premia.signer as any,
)

/*
	@dev: we use only arbitrum mainnet for IV oracles because the
          volatility oracle is not deployed on arbitrum testnet
*/
const ivProvider = new JsonRpcProvider(volatilityOracleRpcUrl)
const ivMultiCallProvider = MulticallWrapper.wrap(ivProvider)
export const ivOracle = IVolatilityOracle__factory.connect(
	volatilityOracle,
	ivMultiCallProvider,
)

const botProvider = new JsonRpcProvider(rpcUrl)
export const botMultiCallProvider = MulticallWrapper.wrap(botProvider)
export const chainlink = IChainlinkAdapter__factory.connect(
	addresses.core.ChainlinkAdapterProxy.address,
	botMultiCallProvider,
)

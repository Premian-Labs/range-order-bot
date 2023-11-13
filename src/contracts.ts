import {
	IPoolFactory__factory,
	IChainlinkAdapter__factory,
	IVolatilityOracle__factory,
	Premia,
	SupportedChainId,
} from '@premia/v3-sdk'
import { JsonRpcProvider, Wallet } from 'ethers'
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

export const provider = premia.provider as JsonRpcProvider
export const signerAddress = (premia.signer as Wallet).address

export const poolFactory = IPoolFactory__factory.connect(
	addresses.core.PoolFactoryProxy.address,
	premia.signer as any,
)

/// @dev: volatility oracle is only available on arbitrum mainnet
const arbiPremia =
	premia.chainId === SupportedChainId.ARBITRUM
		? premia
		: Premia.initializeSync({
				provider: volatilityOracleRpcUrl,
		  })

//TODO: why do we need a multicallProvider for this?
export const ivOracle = IVolatilityOracle__factory.connect(
	volatilityOracle,
	arbiPremia.multicallProvider as any,
)

export const chainlink = IChainlinkAdapter__factory.connect(
	addresses.core.ChainlinkAdapterProxy.address,
	premia.multicallProvider as any,
)

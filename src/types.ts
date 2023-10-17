import { AddressLike, BigNumberish } from 'ethers'

export enum TokenType {
	SHORT = 0,
	LONG = 1,
}
export enum OrderType {
	CS = 1,
	LC = 2,
}
export interface PoolKey {
	base: string
	quote: string
	oracleAdapter: string
	strike: BigNumberish
	maturity: BigNumberish
	isCallPool: boolean
}

export interface PosKey {
	owner: AddressLike
	operator: AddressLike
	lower: BigNumberish
	upper: BigNumberish
	orderType: OrderType // Collateral <-> Long Option
}

export interface SerializedPosKey {
	owner: AddressLike
	operator: AddressLike
	lower: string
	upper: string
	orderType: OrderType // Collateral <-> Long Option
}

export interface MarketParam {
	address: string
	maturities: string[]
	callStrikes: number[]
	putStrikes: number[]
	depositSize: number
	maxExposure: number
	spotPrice?: number
	ts?: number
}

export type MarketParams = Record<string, MarketParam>

export interface Position {
	market: string
	isCall: boolean
	strike: number
	maturity: string
	poolAddress: string
	depositSize: number
	posKey: SerializedPosKey
}

export interface TokenIdParams {
	version: number
	orderType: OrderType
	operator: string
	upper: BigNumberish
	lower: BigNumberish
}

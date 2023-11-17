import { OrderType } from '@premia/v3-sdk'

export interface PosKey {
	owner: string
	operator: string
	lower: bigint
	upper: bigint
	orderType: OrderType
}

export interface SerializedPosKey {
	owner: string
	operator: string
	lower: string
	upper: string
	orderType: OrderType
}

export interface MarketParam {
	address: string
	maturities: string[]
	callStrikes?: number[] // if not passed, will be inferred from delta range
	putStrikes?: number[] // if not passed, will be inferred from delta range
	depositSize: number
	maxExposure: number
	minOptionPrice: number
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

export interface OptionParams {
	market: string
	maturity: string
	type: 'C' | 'P'
	strike: number
	spotPrice: number
	ts: number
	iv: number | undefined
	optionPrice: number | undefined
	delta: number | undefined
	theta: number | undefined
	vega: number | undefined
	cycleOrders: boolean
	ivOracleFailure: boolean
}

import { OrderType } from '@premia/v3-sdk'

export interface State {
	lpRangeOrders: Position[]
	optionParams: OptionParams[]
	portfolioSummary: PortfolioSummary
}

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
	address?: string // hydrated prior to bot running
	maturities: string[]
	spotPriceEstimate?: number // only used to withdraw if no spot price can be fetched
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
	isCollateral: boolean | undefined
}

export interface OptionParams {
	market: string //static
	maturity: string //static
	isCall: boolean //static
	strike: number //static
	spotPrice: number | undefined
	ts: number
	iv: number | undefined
	optionPrice: number | undefined
	delta: number | undefined
	theta: number | undefined
	vega: number | undefined
	cycleOrders: boolean
	ivOracleFailure: boolean
	spotOracleFailure: boolean
	withdrawFailure: boolean
}

export type OptionBalances = Record<string, number>

export interface RangeOrderStats {
	activeRangeOrders: number
	tokenBasedRangeOrders: number
	optionBasedRangeOrders: number
	totalCollateralUsed: number
}
export interface MarketSummary {
	tokenBalance: number
	rangeOrderStats: RangeOrderStats
	tokensUsedAsCollateral: number
	optionsUsedAsCollateral: number
	optionPositions: OptionBalances
}

export type PortfolioSummary = Record<string, MarketSummary>

export interface RangeOrderSpecs {
	posKey: PosKey | null
	collateralAmount: number
	isValidWidth: boolean
	usesOptions: boolean
	minOptionPriceTriggered?: boolean //leftSide ranges only
}

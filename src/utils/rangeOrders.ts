import { OrderType } from '@premia/v3-sdk'
import { formatEther } from 'ethers'

import { VALID_ORDER_WIDTHS } from '../config/constants'
import { PosKey } from './types'
import { log } from './logs'

export async function getCollateralApprovalAmount(
	market: string,
	posKey: PosKey,
	isLeftSide: boolean,
	isCallPool: boolean,
	depositSize: number,
	strike: number,
) {
	const collateralName = isCallPool ? market : 'USDC'
	const baseDecimal = market === `WBTC` ? 8 : 18

	// Left side order using (collateral only)
	if (posKey.orderType == OrderType.LONG_COLLATERAL && isLeftSide) {
		// NOTE: all values are standard format
		const lowerTick = parseFloat(formatEther(posKey.lower))
		const upperTick = parseFloat(formatEther(posKey.upper))
		const averagePrice = (lowerTick + upperTick) / 2

		const collateralValue = Number(
			isCallPool
				? (depositSize * averagePrice).toFixed(baseDecimal)
				: (depositSize * strike * averagePrice).toFixed(6),
		)

		log.info(
			`LEFT side collateral required: ${collateralValue} ${collateralName}`,
		)

		return collateralValue
		// Right side order using (collateral only)
	} else if (posKey.orderType == OrderType.COLLATERAL_SHORT && !isLeftSide) {
		const collateralValue = Number(
			isCallPool
				? depositSize.toFixed(baseDecimal)
				: (depositSize * strike).toFixed(6),
		)

		log.info(
			`RIGHT side collateral required: ${collateralValue} ${collateralName}`,
		)

		return collateralValue
	} else {
		/*
			NOTE: all other cases, we are  use options instead of collateral so the collateral
			amount to approve is zero
			ie order type CS & isLeftSide -> short options being posted on LEFT side
		*/
		return 0
	}
}

export function getValidRangeWidth(
	lowerTick: number,
	upperTick: number,
	orderType: string,
) {
	if (upperTick <= lowerTick) {
		throw new Error(
			`Invalid tick spacing: upper <= lower. Lower: ${lowerTick} Upper: ${upperTick}`,
		)
	} else if (lowerTick <= 0 || upperTick <= 0) {
		throw new Error(
			`Tick can not be zero or negative. Lower: ${lowerTick} Upper: ${upperTick}`,
		)
	} else if ((upperTick * 1000) % 1 !== 0) {
		throw new Error(`Upper tick precision too high. Upper: ${upperTick}`)
	} else if ((lowerTick * 1000) % 1 !== 0) {
		throw new Error(`Lower tick precision too high. Lower: ${lowerTick}`)
	}

	const upperTickScaled = upperTick * 1000
	const lowerTickerScaled = lowerTick * 1000
	const targetWidth = upperTickScaled - lowerTickerScaled

	const closestWidth = VALID_ORDER_WIDTHS.reduce((prev, curr) => {
		return Math.abs(curr - targetWidth) < Math.abs(prev - targetWidth)
			? curr
			: prev
	})

	if (orderType === 'RIGHT') {
		let adjustedUpperTick = lowerTickerScaled + closestWidth

		if (adjustedUpperTick > 1000) {
			log.debug('Closest width too large, trying next lowest....')

			const currentWidthIndex = VALID_ORDER_WIDTHS.indexOf(closestWidth)
			if (currentWidthIndex < 0) {
				throw new Error(`Invalid range order width: ${closestWidth}`)
			}

			adjustedUpperTick =
				lowerTickerScaled + VALID_ORDER_WIDTHS[currentWidthIndex - 1]
		}

		if (adjustedUpperTick > 1000) {
			throw new Error('Adjust upper ticker can not be greater than 1')
		} else if (adjustedUpperTick <= lowerTickerScaled) {
			throw new Error('Adjust upper tick collision')
		}

		return [lowerTickerScaled / 1000, adjustedUpperTick / 1000]
	} else if (orderType === 'LEFT') {
		const adjustedLowerTick = upperTickScaled - closestWidth

		if (adjustedLowerTick <= 0) {
			throw new Error('Adjust lower ticker can not be zero or negative')
		} else if (adjustedLowerTick >= upperTickScaled) {
			throw new Error('Adjust lower tick collision')
		}

		return [adjustedLowerTick / 1000, upperTickScaled / 1000]
	} else {
		throw new Error(`Invalid order type: ${orderType}`)
	}
}

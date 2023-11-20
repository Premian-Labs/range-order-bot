export function getSurroundingStrikes(spotPrice: number, maxProportion = 2) {
	const minStrike = spotPrice / maxProportion
	const maxStrike = spotPrice * maxProportion

	const intervalAtMinStrike = getInterval(minStrike)
	const intervalAtMaxStrike = getInterval(maxStrike)
	const properMin = roundUpTo(minStrike, intervalAtMinStrike)
	const properMax = roundUpTo(maxStrike, intervalAtMaxStrike)

	const strikes = []
	let increment = getInterval(minStrike)
	for (let i = properMin; i <= properMax; i += increment) {
		increment = getInterval(i)
		strikes.push(truncateFloat(i, increment))
	}

	return strikes
}

// Fixes JS float imprecision error
function truncateFloat(input: number, increment: number): number {
	const orderOfIncrement = Math.floor(Math.log10(increment))
	if (orderOfIncrement < 0) {
		return Number(input.toFixed(-orderOfIncrement))
	} else {
		return Number(input.toFixed(0))
	}
}

function roundUpTo(initial: number, rounding: number): number {
	return Math.ceil(initial / rounding) * rounding
}

function getInterval(price: number): number {
	const orderOfTens = Math.floor(Math.log10(price))
	const base = price / 10 ** orderOfTens
	return base < 5 ? 10 ** (orderOfTens - 1) : 5 * 10 ** (orderOfTens - 1)
}

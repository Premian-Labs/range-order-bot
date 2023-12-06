import { marketParams } from '../config'
import { addresses, tokensWithOracles } from '../config/constants'

export function getTokenAddresses() {
	for (const market of Object.keys(marketParams)) {
		if (!tokensWithOracles.includes(market))
			throw new Error(
				`${market} is not a tradable token with the bot. See approved list in README`,
			)
		marketParams[market].address = addresses.tokens[market]
	}
}

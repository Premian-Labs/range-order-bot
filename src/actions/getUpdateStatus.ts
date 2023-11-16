import { OptionParams } from '../utils/types'

export async function getUpdateOptionParams(
	optionParams: OptionParams[],
	market: string,
	curPrice: number,
	ts: number,
) {
	if (optionParams.length == 0) {
		/*
            INITIALIZATION CASE: No values have been established. We need a baseline.
         */
		//TODO: hydrate option params using marketParams markets, maturities & strikes
	} else {
		/*
            MAINTENANCE CASE: is option price has moved beyond threshold, we update params and set update => true so that
            we know this markets need to go through a withdrawal/deposit cycle.
         */
		// TODO: using curPrice and ts, determine how much the option price moved due to delta & theta & vega
		// TODO: if the theo option price changed more than the built-in spread, update all params and set update => true
	}

	return optionParams
}

/*
EXAMPLE:

optionParams = {
 market: WETH,
 maturity: '17Nov23`,
 type: 'C'
 strike: 1700,
 spot: 1826.33,
 ts: 1700158476,
 iv: .62
 delta: .55,
 theta: -4.09
 vega: 1.13
 update: false

}
 */

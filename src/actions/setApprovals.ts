import { MaxUint256 } from 'ethers'

import { addresses } from '../config/constants'
import { marketParams } from '../config'
import { premia, signerAddress } from '../config/contracts'
import { delay } from '../utils/time'
import { log } from '../utils/logs'

export async function setApproval(
	market: string,
	collateralValue: bigint,
	retry: boolean = true,
) {
	const tokenAddress =
		market === 'USDC' ? addresses.tokens.USDC : marketParams[market].address! //set in getAddresses()
	const token = premia.contracts.getTokenContract(
		tokenAddress,
		premia.signer as any,
	)

	try {
		const allowance = await token.allowance(
			signerAddress,
			addresses.core.ERC20Router.address,
		)

		if (allowance >= collateralValue) {
			return
		}

		if (collateralValue === MaxUint256) {
			return token.approve(
				addresses.core.ERC20Router.address,
				MaxUint256.toString(),
			)
		}

		const approveTX = await token.approve(
			addresses.core.ERC20Router.address,
			collateralValue,
		)
		const confirm = await approveTX.wait(1)

		if (confirm?.status == 0) {
			throw new Error(`Failed to confirm approval set: ${confirm}`)
		}
	} catch (err) {
		await delay(2000)
		if (retry) {
			return setApproval(market, collateralValue, false)
		} else {
			log.error(
				`Approval could not be set for ${await token.symbol()}! Try again or check provider and ETH balance...`,
			)
			throw err
		}
	}
}

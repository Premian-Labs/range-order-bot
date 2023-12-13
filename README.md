<div align="center">
  <img src=".github/img/premia.png" alt=''>
</div>

## What is Premia?

Premia is a peer-to-peer options exchange and settlement engine built for the Ethereum Virtual Machine (EVM).
The protocol is designed to provide a set of smart contracts that advance open finance by prioritizing security,
self-custody, automatic execution without a trusted intermediary, and permission-less use of financial primitives.
Additional information about the protocol can be found [here](https://docs.premia.blue/) on our website.

## Range Order Bot

The range order bot is a market making script that allows users to quote two-sided markets (using concentrated
liquidity) for whatever option markets that are preDefined within the settings. IV & Spot oracles are used to 
automatically update range orders as option prices change, minimizing the need for active management of orders. It is 
highly recommended that a user is familiar with how range orders work, and the risks associated with owning option positions.

## PreRequisites

There are a couple of things that are needed in order to work with the range order bot locally. They include:

- An EOA (Externally Owned Account) on Ethereum (funded on _Arbitrum_) with a wallet provider such as [Metamask](https://metamask.io/)
- If funds are on Ethereum (Mainnet) funds can be bridged to Arbitrum [here](https://bridge.arbitrum.io/?l2ChainId=42161)
- The repository is written in Typescript and thus requires [Node](https://nodejs.org/en/download) to be installed
- Git optionally can be used to clone the repository. It can be installed from [here](https://git-scm.com/downloads)
- An RPC provider (such as [Alchemy](https://www.alchemy.com/) or [Infura](https://www.infura.io/)). Due to the higher RPC throughput demand for programmatic trading, a premium RPC API key may be necessary.
- An understanding of range orders and how concentrated liquidity works on Premia v3. If you have not done so please
  see our docs on [Range Orders](https://docs.premia.blue/the-premia-protocol/concepts/lp-range-orders)

## Supported Pairs

The range order bot limited to markets with IV Oracles in order to price markets correctly on chain. All tokens are
automatically paired with USDC (ie WETH/USDC). Please make sure to have sufficient capital in _both_ tokens as the
base token (ie WETH) is used for call collateral, and the quote token (ie USDC) is used for put collateral.

<div align="center">

| Token Symbol | Arbitrum Goerli (Development) | Arbitrum (Production) |
|:------------:|:-----------------------------:|:---------------------:|
|     WETH     |      :heavy_check_mark:       |  :heavy_check_mark:   |
|     WBTC     |      :heavy_check_mark:       |  :heavy_check_mark:   |
|     ARB      |                               |  :heavy_check_mark:   |
|     LINK     |      :heavy_check_mark:       |  :heavy_check_mark:   |
|    WSTETH    |                               |  :heavy_check_mark:   |
|     GMX      |                               |  :heavy_check_mark:   |
|    MAGIC     |                               |  :heavy_check_mark:   |
|     SOL      |                               |  :heavy_check_mark:   |

</div>

## Quick Start

1. Clone the repository on a local computer. Instructions on how to do this can be found [here](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository).
2. Open a terminal and navigate to the root directory, run `yarn install` (if yarn is installed locally) or `npm 
   install` to install package dependencies.
3. Find the `.env.example` file and rename it to `.env`.  Add necessary information that is required. Note that ENV 
   variable should either be `development` for Arbitrum Goerli or `production` to use on Arbitrum Mainnet.
4. Navigate to `src/config/index.example.ts` and rename it to `index.ts`. Review each and every setting. Instructions & descriptions of settings are provided in the example file.
5. Run `yarn start` in the command line to run the range order bot.

## Under The Hood

At this point, you should have a general idea of what this bot is supposed to do (hint: it makes markets in options).
There are many built-in features that a user should be aware.  Some features include:

- The bot will use IV Oracles & Spot Oracles to intelligently price options.
- By default, the bot will post a "bid" and "ask" range order around the fair market value of the option
- The bot utilizes a user defined spread away from the fair value to capture an edge.  Additionally, the bot is 
  entitled to trading [fees](https://docs.premia.blue/the-premia-protocol/concepts/fees) that the taker pays.
- The bot will automatically withdraw range orders, and deposits updated ranges when the spread is lost due to 
  trading or option price movement.
- Since Premia options are ERC1155's. There is both a LONG option token and a SHORT option token.  The 
  bot will automatically pair off long and short exposures to release collateral. 
- If positions accrue, the bot will begin to use options when depositing into range orders instead of collateral.
- If an option that the bot is trading expires, the bot will automatically settle the option to release the collateral.
- The bot will withdraw all liquidity if there is a feed failure in either the IV or Spot Oracle.
- Parameters such as min/max delta and minDTE (days to expiration) can be used to filter what options are traded and 
  when to stop trading them as time passes.
- There are parameters that can be utilized to cap max exposure and enter into "close only" mode

## LIMITATIONS
While the bot has many automated features, it should not be deemed a "set it and forget it" type of bot.  There are 
many things the bot does NOT do.  They include:

- The bot will NOT manage risk for the user.  Options have dynamic properties and their risk evolves over the life 
  of the contract. It is up to the user to make adjustments for this.
- The bot does NOT delta hedge positions.  This is something a user must do on their own.
- The bot will NOT help determine the appropriate size to trade. This is purely at the users discretion
- There is NO built-in management of collateral tokens.  It is up to the user to maintain proper collateral 
  balances for a given market.
- The bot is NOT a money printing black-box. It is merely an automation tool for market making.

## Improvement List & Changelog
-[ ] Enable trading by side (buy only, sell only, both sides)

-[ ] Create parameter to allow taker orders for mispriced options prior to range deposits

-[ ] Enable the use of other quote tokens besides USDC

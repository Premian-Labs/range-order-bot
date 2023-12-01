<div align="center">
  <img src=".github/img/premia.png" alt=''>
</div>

## What is Premia?

Premia is a peer-to-peer options exchange and settlement engine built for the Ethereum Virtual Machine (EVM).
The protocol is designed to provide a set of smart contracts that advance open finance by prioritizing security,
self-custody, automatic execution without a trusted intermediary, and permission-less use of financial primitives.
Additional information about the protocol can be found [here](https://docs.premia.blue/) on our website.

## Premia Range Order Bot

The range order bot is a market making script that allows users to quote two-sided markets (using concentrated
liquidity) for whatever option markets that are preDefined within the settings. It will automatically update range
orders as time passes, minimizing the need for active management of orders. It is highly recommended that a user
is familiar with how range orders work, and the risks associated with owning option positions.

## PreRequisites

There are a couple of things that are needed in order to work with the range order bot locally. They include:

- An EOA (Externally Owned Account) on Ethereum (funded on _Arbitrum_) with a wallet provider such as [Metamask](https://metamask.io/)
- The repository is written in Typescript and thus requires [Node](https://nodejs.org/en/download) to be installed
- An RPC provider (such as [Alchemy](https://www.alchemy.com/) or [Infura](https://www.infura.io/)). Due to the higher RPC throughput demand for programmatic trading, a premium RPC API key may be necessary.
- An understanding of range orders and how concentrated liquidity works on Premia v3. If you have not done so please
  see our docs on [Range Orders](https://docs.premia)

## Supported Pairs

The range order bot limited to markets with IV Oracles in order to price markets correctly on chain. All tokens are
automatically paired with USDC (ie WETH/USDC). Please make sure to have sufficient capital in _both_ tokens as the
base token (ie WETH) is used for call collateral, and the quote token (ie USDC) is used for put collateral.

<div align="center">

| Token Symbol | Arbitrum Goerli (Development) | Arbitrum (Production) |
| :----------: | :---------------------------: | :-------------------: |
|     WETH     |      :heavy_check_mark:       |  :heavy_check_mark:   |
|     WBTC     |      :heavy_check_mark:       |  :heavy_check_mark:   |
|     ARB      |                               |  :heavy_check_mark:   |
|     LINK     |      :heavy_check_mark:       |  :heavy_check_mark:   |
|    wstETH    |                               |  :heavy_check_mark:   |
|     GMX      |                               |  :heavy_check_mark:   |
|    MAGIC     |                               |  :heavy_check_mark:   |

</div>

## Premia Range Order Bot

The range order bot is a market making script that allows users to quote two-sided markets (using concentrated
liquidity) for whatever option markets that are preDefined within the settings. It will automatically update range
orders as time passes, minimizing the need for active management of orders. It is highly recommended that a user
is familiar with how range orders work, and the risks associated with owning option positions.

## Quick Start

1. Clone the repository on a local computer. Instructions on how to do this can be found [here](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository).
2. Open a terminal and navigate to the root directory, run `yarn install` to install package dependencies.
3. Find the `.env.example` file and rename it to `.env`.  Add necessary information that is required. Note that ENV 
   variable should either be `development` for Arbitrum Goerli or `production` to use on Arbitrum Mainnet.
4. Navigate to `src/config/index.example.ts` and rename it to `index.ts`. Review each and every setting. Instructions & descriptions of settings are provided in the example file.
5. Run `yarn start` in the command line to run the range order bot.

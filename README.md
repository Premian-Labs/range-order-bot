<div align="center">
  <img src="img/premia.png" alt=''>
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
There are a couple of things that are needed in order to work with the range order bot locally.  They include:
- An EOA (Externally Owned Account) on Ethereum (funded on _Arbitrum_) with a wallet provider such as [Metamask](https://metamask.io/)
- The repository is written in Typescript and thus requires [Node](https://nodejs.org/en/download) to be installed
- An API Key from [Infura](https://www.infura.io/)
- A solid understanding of range orders and how concentrated liquidity works on Premia v3. If you have not done so 
  please see our docs on [Range Orders](https://docs.premia)

## Supported Pairs
The range order bot depends on IV Oracles in order to price markets correctly on chain.  All tokens are 
automatically paired with USDC (ie WETH/USDC). Please make sure to have sufficient capital in _both_ tokens as the 
base token (ie WETH) is used for call collateral, and the quote token (ie USDC) is used for put collateral. 

<div align="center">

| Token Symbol  | Arbitrum Goerli (Development) |         Arbitrum (Production)          |
|:-------------:|:-----------------------------:|:--------------------------------------:|
|     WETH      |      :heavy_check_mark:       |           :heavy_check_mark:           |
|     WBTC      |      :heavy_check_mark:       |           :heavy_check_mark:           |
|      ARB      |                               |           :heavy_check_mark:           | 
|     LINK      |      :heavy_check_mark:       |           :heavy_check_mark:           |
|    wstETH     |                               |           :heavy_check_mark:           |
|      GMX      |                               |           :heavy_check_mark:           |
|     MAGIC     |                               |           :heavy_check_mark:           |

</div>

## Quick Start
1. Clone the repository on a local computer.
2. While in the root directory, run `yarn install` to install package dependencies (this will also generate a 
   `typechain` folder).
3. Create a `.env` file using the same format at the example and add necessary information. Note that ENV should 
   either be `development` or `production`.  
4. Navigate to `src/config/liquiditySettings.ts` and review each and ever setting.  Instructions & descriptions of 
   settings are provided in the file. 
5. Run `yarn start` in the command line to run the range order bot.


## Improvement List & Changelog
- [ ] make position json files for both development and production
- [x] add list of available pairs for trading in read me
- [ ] make minOptionPrice per market for better granular control
- [ ] convert timeThresholdMin into hours
- [ ] refactor base token address out of marketParams (not a trade setting)
- [ ] ignore liquidity settings to avoid loss of trade setting on repo updates
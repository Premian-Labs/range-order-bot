<p align="center">
  <img src="img/premia.png" alt=''>
</p>

## What is Premia?
Premia is a peer-to-peer options exchange and settlement engine built for the Ethereum Virtual Machine (EVM).
The protocol is designed to provide a set of smart contracts that advance open finance by prioritizing security,
self-custody, automatic execution without a trusted intermediary, and permission-less use of financial primitives.
Additional information about the protocol can be found [here](https://docs.premia.blue/) on our website.

## PreRequisites
There are a couple of things that are needed in order to work with the range order bot locally.  They include:
- An EOA (Externally Owned Account) on Ethereum (funded on Arbitrum) with a wallet provider such as [Metamask](https://metamask.io/)
- The repository is written in Typescript and thus requires [Node](https://nodejs.org/en/download) to be installed
- An API Key from [Infura](https://www.infura.io/)
- An understanding of range orders and how concentrated liquidity works on Premia v3. If you have not done so please 
  see our docs on [Range Orders](https://docs.premia)

## Premia Range Order Bot
  The range order bot is a market making script that allows users to quote two-sided markets (using concentrated 
  liquidity) for whatever option markets that are preDefined within the settings. It will automatically update range 
  orders as time passes, minimizing the need for active management of orders. It is highly recommended that a user 
  is familiar with how range orders work, and the risks associated with owning option positions.  
  

## Setup
1. Clone the repository on a local computer.
2. Run `./abi.sh` in the command line within the directory (this should generate an `abi` folder in the root directory).
3. While in the root directory, run `yarn install` to install package dependencies (this will also generate a 
   `typechain` folder).
4. Create a `.env` file using the same format at the example and add necessary information. Note that ENV should 
   either be `development` or `production`.  
5. Navigate to `src/config/liquiditySettings.ts` and review each and ever setting.  Instructions & descriptions of 
   settings are provided in the file. 
6. Run `yarn start` in the command line to run the range order bot.
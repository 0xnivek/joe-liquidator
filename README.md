# Joe Liquidator 🌊

This repository is a liquidation bot built for [**Trader Joe**](https://traderjoexyz.com/#/home), a 
DEX and lending service built on the [**Avalanche**](https://www.avax.network/) network.

It was built adhering to this [*Trader Joe Liquidation Bot Flash Loans Spec*](https://docs.google.com/document/d/1k8GusDAk-dLO8heNG-d4YJkmx8Z8vVMsIfS1R6QeMUE/edit).

## Structure

This repository is broken up into two main directories, `liquidator` and `liquidator-bot`

### `liquidator`

This directory contains all of our smart contracts. The main one is `liquidator/contracts/JoeLiquidator.sol`
which contains an external `liquidate` function:

```solidity
contract JoeLiquidator {
  function liquidate(
      address _borrowerToLiquidate,
      address _jRepayTokenAddress,
      address _jSeizeTokenAddress
  ) external;
}
```

To learn more, see [Liquidation](#liquidation).

### `liquidator-bot`

This directory contains a [node.js](https://nodejs.org/en/) project which is what continously
searches for liquidatable accounts and calls our `JoeLiquidator` contract periodically.

## Setup

The only setup required is to make a copy of `liquidator-bot/env.template` and rename it to
`liquidator-bot/.env`.

In this file, insert the private key of the wallet address you would like to use to perform
liquidation for the `WALLET_PRIVATE_KEY` environnment variable.

## Liquidation


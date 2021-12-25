# Joe Liquidator 🌊

This repository is a liquidation bot built for [**Trader Joe**](https://traderjoexyz.com/#/home), a 
DEX and lending service built on the [**Avalanche**](https://www.avax.network/) network.

It was built adhering to this [*Trader Joe Liquidation Bot Flash Loans Spec*](https://docs.google.com/document/d/1k8GusDAk-dLO8heNG-d4YJkmx8Z8vVMsIfS1R6QeMUE/edit).

## Structure

This repository is broken up into two main directories, `liquidator` and `liquidator-bot`

### `liquidator`

This directory contains all relevant smart contracts. The main one is `liquidator/contracts/JoeLiquidator.sol`
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

To learn more, see [Liquidation Algorithm](#liquidation-algorithm).

### `liquidator-bot`

This directory contains a [node.js](https://nodejs.org/en/) project which is what continously
searches for liquidatable accounts and calls our `JoeLiquidator` contract periodically.

## Setup

The only setup required is to make a copy of `liquidator-bot/env.template` and rename it to
`liquidator-bot/.env`.

In this file, insert the private key of the wallet address you would like to use to perform
liquidation for the `WALLET_PRIVATE_KEY` environnment variable.

## Installation

```
git clone https://github.com/kevinchan159/joe-liquidator.git
cd joe-liquidator/liquidator
yarn install
cd ../liquidator-bot
yarn install
```

## Building

To compile the smart contracts:

```
cd liquidator
yarn compile
```

To run the bot:

```
cd liquidator-bot
yarn start
```

## Testing

The smart contract tests are defined under the [liquidator/test](https://github.com/kevinchan159/joe-liquidator/tree/main/liquidator/test) directory. To run them:

```
cd liquidator
yarn test
```

## Background

### Liquidation

Liquidation is possible when an account is incurring a shortfall, i.e. their total borrow balance exceeds their total
collateral balance. To prevent the potential losses, the protocol exposes a public `liquidateBorrow/liquidateBorrowNative` 
function that can be called by anyone to "liquidate" an underwater account.

Liquidation is the process of selling a portion of the underwater account's collateral at a discounted rate, i.e.
the *liquidation incentive*, to a liquidator in exchange for the liquidator repaying an equivalent amount of the underwater
account's borrow position. The maximum amount of collateral that can be sold to the liquidator is determined by the *close factor*.

### Flash Loans

Flash loans are a special type of loan that allows one to take out a loan **without providing collateral**. The reason this is
possible is that if the borrower doesn't repay the flash loan (+ flash loan fee) by the end of the transaction, the whole transaction
is reverted completely.

## Liquidation Algorithm

*Joe Liquidator* performs liquidation using [**flash loans**](#flash-loans). The algorithm followed for liquidation
is as follows:

1. Liquidator calls `JoeLiquidator#liquidate` passing in:
   - borrower to liquidate
   - jToken of the borrow position to repay
   - jToken of the supply position to seize
2. Check that the borrower is indeed liquidatable, i.e.:
   - liquidity is zero
   - shortfall is non-zero
3. Decide which jToken to flash loan:
   - if the borrow position to repay is `jUSDC`, flash loan from `jWETH`
   - else flash loan from `jUSDC`
3. Calculate amount of the borrow position to repay
4. Calculate amount to flash loan:
   - determined by calling `JoeRouter#getAmountsIn` to see how much of the flash loan token is needed to swap for the repay amount
5. Perform flash loan
6. Upon receiving flash loan, swap the flash loan tokens for the repay tokens using `JoeRouter`
7. Call `liquidateBorrow` on the jToken borrow position to repay and receive jTokens from the supply position to seize
8. Redeem seized collateral using the jTokens we received from liquidation
9. Swap enough of the seized collateral to flash loan tokens using `JoeRouter`:
    - total amount of flash tokens needed is the `flash loan amount + flash loan fee`
    - amount to swap is calculated using `JoeRouter#getAmountsIn`
10. Swap any of the remaining seized collateral left to AVAX (unless the collateral is AVAX)
11. Transfer profited AVAX back to liquidator
12. Repay flash loan

In step 3, you may be wondering why we don't simply flash loan the token of the borrow position
that we're repaying. The reason is that the jToken contracts have a reetrancy guard which means that
you cannot `flashLoan` and `liquidateBorrow` the same token. Thus, we have to flash loan a different token,
swap the flash loan token for the repay token, and then call `liquidateBorrow`.

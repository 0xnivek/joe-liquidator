const ethers = require('ethers');
const fetch = require('isomorphic-unfetch');
const { createClient, gql } = require('@urql/core');

const JOE_LIQUIDATOR_ABI = require('./abis/JoeLiquidator');

const { JOE_LIQUIDATOR_CONTRACT_ADDRESS, WALLET_PRIVATE_KEY } = process.env;

const INTERVAL_IN_MS = 10000;

/// From https://thegraph.com/hosted-service/subgraph/traderjoe-xyz/lending?query=underwater%20accounts
const TRADER_JOE_LENDING_GRAPH_URL = 'https://api.thegraph.com/subgraphs/name/traderjoe-xyz/lending';
const UNDERWATER_ACCOUNTS_QUERY = gql`
  query {
    accounts(where: {health_gt: 0, health_lt: 1, totalBorrowValueInUSD_gt: 0}) {
      id
      health
      totalBorrowValueInUSD
      totalCollateralValueInUSD
      tokens {
        id
        symbol
        market {
          name
          symbol
          collateralFactor
          underlyingPriceUSD
          exchangeRate
          reserveFactor
          underlyingDecimals
        }
        borrowBalanceUnderlying
        supplyBalanceUnderlying
        enteredMarket
      }
    }
  }
`

const URQL_CLIENT = createClient({
  url: TRADER_JOE_LENDING_GRAPH_URL,
});

/**
 * Returns jToken address and symbol from a token.
 */
const getJTokenData = (token) => {
  const { id, market } = token;
  const { symbol } = market;

  // id is formatted as '<jToken address>-<borrower address>'
  const jTokenAddress = id.slice(0, id.indexOf('-'));
  return {
    jTokenAddress,
    symbol
  };
}

/**
 * Returns borrow value in USD from a token. 
 * Calculated as `borrowBalanceUnderlying` * `underlyingPriceUSD`.
 */
const getBorrowValueInUSD = (token) => {
  const { borrowBalanceUnderlying: borrowBalanceUnderlyingStr, market } = token;
  const { underlyingPriceUSD: underlyingPriceUSDStr } = market;
  return parseFloat(borrowBalanceUnderlyingStr) * parseFloat(underlyingPriceUSDStr);
}

/**
 * Returns supply value in USD from a token. 
 * Calculated as `supplyBalanceUnderlying` * `underlyingPriceUSD`.
 */
const getSupplyValueInUSD = (token) => {
  const { supplyBalanceUnderlying: supplyBalanceUnderlyingStr, market } = token;
  const { underlyingPriceUSD: underlyingPriceUSDStr } = market;
  return parseFloat(supplyBalanceUnderlyingStr) * parseFloat(underlyingPriceUSDStr);
}

/**
 * Finds a supply position to seize given a borrow position to repay.
 * Requirements are:
 * - `enteredMarket === true` to have been posted as collateral
 * - `supplyValue >= borrowValue * 0.5`
 */
const findSupplyPositionToSeize = (tokens, borrowId, borrowValue) => {
  for (const token of tokens) {
    const { enteredMarket, id: supplyId } = token;

    // 1. Need to have `enteredMarket` to have been posted as collateral
    // 2. Borrow and supply position can't be the same token
    if (!enteredMarket || borrowId === supplyId) {
      continue;
    }

    const supplyValue = getSupplyValueInUSD(token);
    // Must have enough supply to seize 50% of borrow value
    if (supplyValue >= borrowValue * 0.5) {
      return token;
    }
  }
  return null;
}

/**
 * Finds a supply position to seize given a borrow position to repay given
 * the tokens of an underwater account.
 */
const findBorrowAndSupplyPosition = (tokens) => {
  for (const token of tokens) {
    const { id: borrowId } = token;
    const borrowValue = getBorrowValueInUSD(token);
    if (borrowValue > 0) {
      const supplyPositionToSeize = findSupplyPositionToSeize(tokens, borrowId, borrowValue);
      if (supplyPositionToSeize !== null) {
        return { borrowPositionToRepay: token, supplyPositionToSeize };
      }
    }
  }
  return null;
}

/**
 * Returns a `JoeLiquidator` contract to interact with.
 */
const getJoeLiquidatorContract = () => {
  // Following https://medium.com/coinmonks/hello-world-smart-contract-using-ethers-js-e33b5bf50c19
  const provider = ethers.getDefaultProvider();
  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
  return new ethers.Contract(JOE_LIQUIDATOR_CONTRACT_ADDRESS, JOE_LIQUIDATOR_ABI, wallet);
}

/**
 * Tries to liquidate an account by searching for a borrow position to repay and
 * supply position to seize.
 */
const tryLiquidateAccount = async (account) => {
  const { tokens } = account;

  const borrowAndSupplyPosition = findBorrowAndSupplyPosition(tokens);
  if (borrowAndSupplyPosition === null) {
    console.log("😴 No liquidatable accounts found. Sleeping for 5 seconds...");
    return;
  }

  console.log("🤩 Found underwater account to liquidate!");
  const { borrowPositionToRepay, supplyPositionToSeize } = borrowAndSupplyPosition;

  const { jTokenAddress: jRepayTokenAddress, symbol: jRepayTokenSymbol } = getJTokenData(borrowPositionToRepay);
  const { jTokenAddress: jSeizeTokenAddress, symbol: jSeizeTokenSymbol } = getJTokenData(supplyPositionToSeize);
  const { id: borrowerToLiquidateAddress } = account;

  console.log(
    `🌊 Performing liquidation on borrower ${borrowerToLiquidateAddress} with borrow position ` +
    `on ${jRepayTokenSymbol} and supply position on ${jSeizeTokenSymbol}`
  );

  const joeLiquidatorContract = getJoeLiquidatorContract();
  await joeLiquidatorContract.liquidate(
    borrowerToLiquidateAddress,
    jRepayTokenAddress,
    jSeizeTokenAddress
  );
}

/**
 * Queries the Banker Joe lending subgraph for underwater accounst and attemps
 * to perform liquidation using `JoeLiquidator.sol`.
 */
const run = async () => {
  URQL_CLIENT.query(UNDERWATER_ACCOUNTS_QUERY)
    .toPromise()
    .then(async (result) => {
      console.log("🔎 Searching for account to liquidate...");

      const { data: { accounts } } = result;
      for (const account of accounts) {
        await tryLiquidateAccount(account);
      }

      console.log(`✨ Finished searching through accounts...\n`);
    })
    .catch((err) => {
      console.log('Error performing liquidation: ', err);
    })
}

console.log("🔧 Bot starting up...");
console.log(`🔁 Bot will query the subgraph every ${INTERVAL_IN_MS / 1000} seconds to search for liquidatable accounts...\n`);

if (!JOE_LIQUIDATOR_CONTRACT_ADDRESS) {
  console.log("🚨 Stopping because the `JOE_LIQUIDATOR_CONTRACT_ADDRESS` environment variable isn't set.")
  return;
}

if (!WALLET_PRIVATE_KEY) {
  console.log("🚨 Stopping because the `WALLET_PRIVATE_KEY` environment variable isn't set.")
  return;
}

/// Query the subgraph and attempt to perform liquidation every INTERVAL_IN_MS
setInterval(run, INTERVAL_IN_MS);
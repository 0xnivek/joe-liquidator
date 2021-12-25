const ethers = require('ethers');
const fetch = require('isomorphic-unfetch');
const { createClient, gql } = require('@urql/core');

const JOE_LIQUIDATOR_ABI = require('./abis/JoeLiquidator');
const WAVAX_ABI = require('./abis/WAVAX');
const WETH_ABI = require('./abis/WETH');

const { WALLET_PRIVATE_KEY } = process.env;

const JOE_LIQUIDATOR_CONTRACT_ADDRESS = "0xdc13687554205E5b89Ac783db14bb5bba4A1eDaC";
const WAVAX_CONTRACT_ADDRESS = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
const WETH_CONTRACT_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// From https://thegraph.com/hosted-service/subgraph/traderjoe-xyz/lending?query=underwater%20accounts
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

const client = createClient({
  url: TRADER_JOE_LENDING_GRAPH_URL,
});

const getBorrowValueInUSD = (token) => {
  const { borrowBalanceUnderlying: borrowBalanceUnderlyingStr, market } = token;
  const { underlyingPriceUSD: underlyingPriceUSDStr } = market;
  return parseFloat(borrowBalanceUnderlyingStr) * parseFloat(underlyingPriceUSDStr);
}

const getSupplyValueInUSD = (token) => {
  const { supplyBalanceUnderlying: supplyBalanceUnderlyingStr, market } = token;
  const { underlyingPriceUSD: underlyingPriceUSDStr } = market;
  return parseFloat(supplyBalanceUnderlyingStr) * parseFloat(underlyingPriceUSDStr);
}

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

const run = async () => {
  client.query(UNDERWATER_ACCOUNTS_QUERY)
    .toPromise()
    .then((result) => {
      const { data: { accounts } } = result;
      const account = accounts[0];
      // Approximately:
      // totalBorrowValueInUSD = sum(borrowBalanceUnderlying * underlyingPriceUSD)
      // totalCollateralValueInUSD = sum(supplyBalanceUnderlying * underlyingPriceUSD * collateralFactor)
      const { totalBorrowValueInUSD, totalCollateralValueInUSD, tokens } = account;
      console.log("totalBorrowValueInUSD:", totalBorrowValueInUSD);
      console.log("totalCollateralValueInUSD:", totalCollateralValueInUSD);
      // console.log("TOKENS:", tokens);

      const { borrowPositionToRepay, supplyPositionToSeize } = findBorrowAndSupplyPosition(tokens)
      console.log("BORROW POSITION TO REPAY:", borrowPositionToRepay);
      console.log("SUPPLY POSITION TO SEIZE:", supplyPositionToSeize);
    })
    .catch((err) => {
      console.log('Error fetching subgraph data: ', err);
    })
}

run();
return

const testing = async () => {
  // Following https://medium.com/coinmonks/hello-world-smart-contract-using-ethers-js-e33b5bf50c19
  const provider = ethers.getDefaultProvider();
  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
  // const wavaxContract = new ethers.Contract(WAVAX_CONTRACT_ADDRESS, WAVAX_ABI, wallet);
  const wethContract = new ethers.Contract(WETH_CONTRACT_ADDRESS, WETH_ABI, wallet);

  console.log(await wethContract.name());
  console.log(await wethContract.symbol());
}
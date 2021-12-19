const fetch = require('isomorphic-unfetch');
const { createClient, gql } = require('@urql/core');

// From https://thegraph.com/hosted-service/subgraph/traderjoe-xyz/lending?query=underwater%20accounts
const TRADER_JOE_LENDING_GRAPH_URL = 'https://api.thegraph.com/subgraphs/name/traderjoe-xyz/lending';
const UNDERWATER_ACCOUNTS_QUERY = gql`
  query {
    accounts(where: {health_gt: 0, health_lt: 1, totalBorrowValueInUSD_gt: 0}) {
      id
      health
      totalBorrowValueInUSD
      totalCollateralValueInUSD
    }
  }
`

const client = createClient({
  url: TRADER_JOE_LENDING_GRAPH_URL,
});

client.query(UNDERWATER_ACCOUNTS_QUERY)
  .toPromise()
  .then((result) => {
    console.log('Subgraph data: ', result);
    const { data: { accounts } } = result;
    console.log("ACCOUNTS:", accounts);
  })
  .catch((err) => {
    console.log('Error fetching subgraph data: ', data);
  })
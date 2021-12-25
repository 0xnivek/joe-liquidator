// Based on https://github.com/Sanghren/avalanche-hardhat-fork-tutorial
const AVALANCHE_NODE_URL = "https://api.avax.network/ext/bc/C/rpc";
const BLOCK_NUMBER = 8704585;
const SECONDS_IN_MINUTE = 60;
const SECONDS_IN_HOUR = SECONDS_IN_MINUTE * 60;
const SECONDS_IN_DAY = SECONDS_IN_HOUR * 24;


const getTxnLogs = (contract, txnReceipt) => {
  const logs = [];
  for (const log of txnReceipt.logs) {
    try {
      logs.push(contract.interface.parseLog(log));
    } catch (err) {
      // Means that log isn't an event emitted from our contract
    }
  }
  return logs;
}

module.exports = {
  AVALANCHE_NODE_URL,
  BLOCK_NUMBER,
  SECONDS_IN_MINUTE,
  SECONDS_IN_HOUR,
  SECONDS_IN_DAY,
  getTxnLogs
};
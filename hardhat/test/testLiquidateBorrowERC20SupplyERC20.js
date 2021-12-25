const {
  ethers
} = require("hardhat");
const {
  use,
  expect
} = require("chai");
const {
  solidity, link
} = require("ethereum-waffle");
const { isCallTrace } = require("hardhat/internal/hardhat-network/stack-traces/message-trace");

const {
  AVALANCHE_NODE_URL,
  BLOCK_NUMBER,
  SECONDS_IN_MINUTE,
  SECONDS_IN_HOUR,
  SECONDS_IN_DAY,
  getTxnLogs
} = require("./utils/helpers");

use(solidity);

const JOETROLLER_ADDRESS = "0xdc13687554205E5b89Ac783db14bb5bba4A1eDaC";
const JOE_ROUTER_02_ADDRESS = "0x60aE616a2155Ee3d9A68541Ba4544862310933d4";
const JWETHE_ADDRESS = "0x929f5caB61DFEc79a5431a7734a68D714C4633fa";
const JUSDCE_ADDRESS = "0xEd6AaF91a2B084bd594DBd1245be3691F9f637aC";
const JLINKE_ADDRESS = "0x585E7bC75089eD111b656faA7aeb1104F5b96c15";
const JUSDTE_ADDRESS = "0x8b650e26404AC6837539ca96812f0123601E4448";

const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
const WETHE = "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB";
const USDTE = "0xc7198437980c041c805A1EDcbA50c1Ce5db95118";
const LINKE = "0x5947BB275c521040051D82396192181b413227A3";

describe("JoeLiquidator", function () {
  let joeLiquidatorContract;
  let joetrollerContract;
  let joeRouterContract;
  let jLINKEContract;
  let jUSDTEContract;
  let linkeContract;

  let owner;
  let addr1;
  let addr2;

  beforeEach(async () => {
    await ethers.provider.send(
      "hardhat_reset",
      [
        {
          forking: {
            jsonRpcUrl: AVALANCHE_NODE_URL,
            blockNumber: BLOCK_NUMBER
          },
        },
      ],
    );

    const JoeLiquidatorContractFactory = await ethers.getContractFactory("JoeLiquidator");
    joeLiquidatorContract = await JoeLiquidatorContractFactory.deploy(
      JOETROLLER_ADDRESS,
      JOE_ROUTER_02_ADDRESS,
      JUSDCE_ADDRESS,
      JWETHE_ADDRESS
    );

    joetrollerContract = await ethers.getContractAt("Joetroller", JOETROLLER_ADDRESS);
    joeRouterContract = await ethers.getContractAt("JoeRouter02", JOE_ROUTER_02_ADDRESS);
    jLINKEContract = await ethers.getContractAt("JCollateralCapErc20Delegator", JLINKE_ADDRESS);
    jUSDTEContract = await ethers.getContractAt("JCollateralCapErc20Delegator", JUSDTE_ADDRESS);
    linkeContract = await ethers.getContractAt("ERC20", LINKE);

    [owner, addr1, addr2] = await ethers.getSigners();
  });

  describe("Test liquidate ERC20 borrow position and ERC20 supply position", function () {
    // Collateral factor of jUSDT (borrow): 0.8
    // Collateral factor of jLINK (supply): 0.6
    it("Test liquidate USDT borrow position and LINK supply position", async function () {
      const currBlock = await ethers.provider.getBlock();
      console.log("CURRENT BLOCK NUMBER:", currBlock.number);

      // Increase default timeout from 20s to 60s
      this.timeout(60000)

      // Following guide here: https://medium.com/compound-finance/borrowing-assets-from-compound-quick-start-guide-f5e69af4b8f4

      const [errBeginning, liquidityBeginning, shortfallBeginning] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY BEGINNING:", liquidityBeginning);
      console.log("SHORTFUL BEGINNING:", shortfallBeginning);

      /// 0. Swap AVAX for 1 LINK.e
      /// Note: 0.165 AVAX ~= 1 LINK.e
      const amountOfAVAXToSwap = ethers.utils.parseEther("0.5");

      const linkeBalanceBeforeSwap = await linkeContract.balanceOf(owner.address);
      expect(linkeBalanceBeforeSwap.eq(0)).to.equal(true);
      console.log("LINKE BALANCE BEFORE SWAP:", linkeBalanceBeforeSwap);

      const currentBlock = await ethers.provider.getBlock();
      const swapAVAXForLINKE = await joeRouterContract.connect(owner).swapExactAVAXForTokens(
        ethers.utils.parseEther("1"),
        [WAVAX, LINKE],
        owner.address,
        currentBlock.timestamp + SECONDS_IN_MINUTE,
        { value: amountOfAVAXToSwap }
      );
      await swapAVAXForLINKE.wait();

      const linkeBalanceAfterSwap = await linkeContract.balanceOf(owner.address);
      expect(linkeBalanceAfterSwap.gt(0)).to.equal(true);
      console.log("LINKE BALANCE AFTER SWAP:", linkeBalanceAfterSwap);

      /// 1. Supply 1 LINK.e to jLINK contract as collateral
      const jLINKEBalanceUnderlyingBefore = await jLINKEContract.balanceOfUnderlying(owner.address);
      console.log("OWNER jLINK.e BALANCE UNDERLYING BEFORE", jLINKEBalanceUnderlyingBefore);
      expect(jLINKEBalanceUnderlyingBefore).to.equal(0);

      // Note: LINK.e is 18 decimals
      const amountOfLINKEToSupply = ethers.utils.parseEther("1");

      // Approve jLINK.e contract to take LINK.e
      const approveJLINKETxn = await linkeContract.connect(owner).approve(JLINKE_ADDRESS, amountOfLINKEToSupply)
      await approveJLINKETxn.wait();

      // Supply LINK.e to jLINK.e contract
      const mintLINKETxn = await jLINKEContract.connect(owner).mint(amountOfLINKEToSupply);
      await mintLINKETxn.wait();
      console.log("Supplying LINK.e as collateral to jLINK.e...");

      const jLINKEBalanceUnderlyingAfter = await jLINKEContract.balanceOfUnderlying(owner.address);
      console.log("OWNER jLINK.e BALANCE UNDERLYING AFTER", jLINKEBalanceUnderlyingAfter);
      expect(jLINKEBalanceUnderlyingAfter.gt(0)).to.equal(true);

      // 0.6 LINK.E ~= 12.221 USDT.e

      /// 2. Enter market via Joetroller for jLINK.e for using LINK.e as collateral
      expect(
        await joetrollerContract
          .checkMembership(owner.address, JLINKE_ADDRESS)
      ).to.equal(false);
      await joetrollerContract.connect(owner).enterMarkets([JLINKE_ADDRESS])
      expect(
        await joetrollerContract
          .checkMembership(owner.address, JLINKE_ADDRESS)
      ).to.equal(true);


      /// 3. Get account liquidity in protocol before borrow
      const [errBeforeBorrow, liquidityBeforeBorrow, shortfallBeforeBorrow] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY BEFORE BORROW:", liquidityBeforeBorrow);
      console.log("SHORTFUL BEFORE BORROW:", shortfallBeforeBorrow);


      /// 4. Fetch borrow rate per second for jUSDT.e
      const jUSDTEBorrowRatePerSecond = await jUSDTEContract.borrowRatePerSecond();
      expect(jUSDTEBorrowRatePerSecond.gt(0)).to.equal(true);
      console.log("jUSDT.e BORROW RATE PER SECOND:", jUSDTEBorrowRatePerSecond);


      // 5. Get jLINKE collateral factor. Queried by using Joetroller#markets(address _jTokenAddress) => Market
      const jLINKECollateralFactor = 0.6;


      /// 6. Borrow USDT.e from jUSDT.e contract.
      /// Note: 
      /// 1. 0.6 LINK.E ~= 12.221 USDT.e so we should borrow 11 USDT.e
      /// 2. USDT.e has 6 decimals

      // Confirm jUSDT.e borrowBalanceCurrent is 0 before we borrow
      const jUSDTEBorrowBalanceBefore = await jUSDTEContract.borrowBalanceCurrent(owner.address);
      console.log("jUSDT.e BORROW BALANCE BEFORE:", jUSDTEBorrowBalanceBefore);
      expect(jUSDTEBorrowBalanceBefore).to.equal(0);

      // Borrow 11 USDT.e from jUSDT.e contract
      console.log("Borrowing...");
      const amountOfUSDTEToBorrow = ethers.utils.parseUnits("11", 6);
      const borrowTxn = await jUSDTEContract.connect(owner).borrow(amountOfUSDTEToBorrow);
      // Have to call `wait` to get transaction mined.
      await borrowTxn.wait();

      // Confirm jUSDT.e borrowBalanceCurrent after borrow is 11.0 USDT.e
      const jUSDTEBorrowBalanceAfter = await jUSDTEContract.borrowBalanceCurrent(owner.address);
      console.log("jUSDT.e BORROW BALANCE AFTER:", jUSDTEBorrowBalanceAfter);
      expect(jUSDTEBorrowBalanceAfter.eq(amountOfUSDTEToBorrow)).to.equal(true);

      const [errAfterBorrow, liquidityAfterBorrow, shortfallAfterBorrow] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY AFTER BORROW:", liquidityAfterBorrow);
      console.log("SHORTFALL AFTER BORROW:", shortfallAfterBorrow);

      /// 7. Increase time, mine block, and accrue interest so that we can make account liquidatable!
      await ethers.provider.send("evm_increaseTime", [SECONDS_IN_DAY * 30 * 12 * 5]);
      await ethers.provider.send("evm_mine");

      // Need to accrue interest for both the borrow and supply jToken, otherwise
      // we run into this error in JToken#liquidateBorrowFresh:
      // https://github.com/traderjoe-xyz/joe-lending/blob/main/contracts/JToken.sol#L726-L732
      const accrueUSDTEInterestTxn = await jUSDTEContract.accrueInterest();
      await accrueUSDTEInterestTxn.wait();

      const accrueLINKEInterestTxn = await jLINKEContract.accrueInterest();
      await accrueLINKEInterestTxn.wait();

      const jUSDTEBorrowBalanceAfterMining = await jUSDTEContract.borrowBalanceCurrent(owner.address);
      console.log("jUSDTE BORROW BALANCE AFTER MINING:", jUSDTEBorrowBalanceAfterMining);

      // Confirm account has shortfall, a.k.a. can be liquidated 
      const [errAfterMining, liquidityAfterMining, shortfallAfterMining] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY AFTER MINING:", liquidityAfterMining);
      console.log("SHORTFALL AFTER MINING:", shortfallAfterMining);

      /// 8. Liquidate account!
      console.log("Starting liquidation...");
      const liquidateTxn = await joeLiquidatorContract.connect(addr1).liquidate(owner.address, JUSDTE_ADDRESS, JLINKE_ADDRESS);
      const liquidationTxnReceipt = await liquidateTxn.wait();

      const liquidationTxnLogs = getTxnLogs(joeLiquidatorContract, liquidationTxnReceipt);

      expect(liquidationTxnLogs.length).to.equal(1);

      const liquidationEventLog = liquidationTxnLogs[0];

      expect(liquidationEventLog.name).to.equal('LiquidationEvent');

      const [
        borrowerLiquidated,
        jRepayTokenAddress,
        jSeizeTokenAddress,
        repayAmount,
        profitedAvax,
        ...rest
      ] = liquidationEventLog.args;

      expect(borrowerLiquidated).to.equal(owner.address);
      expect(jRepayTokenAddress).to.equal(JUSDTE_ADDRESS);
      expect(jSeizeTokenAddress).to.equal(JLINKE_ADDRESS);
      expect(repayAmount.gt(0)).to.equal(true);
      expect(profitedAvax.gt(0)).to.equal(true);

      // Amount repaid was 9334394 and profited 0.004084249707846783 AVAX!
      console.log(
        `Successfully liquidated ${borrowerLiquidated} for jRepayToken ${jRepayTokenAddress} ` +
        `and jSeizeToken ${jSeizeTokenAddress}.`
      );
      console.log(
        `Amount repaid was ${repayAmount} and profited ${ethers.utils.formatEther(profitedAvax)} AVAX!`
      );
    });
  });

});
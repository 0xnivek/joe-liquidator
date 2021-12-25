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
const JAVAX_ADDRESS = "0xC22F01ddc8010Ee05574028528614634684EC29e";
const JLINK_ADDRESS = "0x585E7bC75089eD111b656faA7aeb1104F5b96c15";
const JUSDC_ADDRESS = "0xEd6AaF91a2B084bd594DBd1245be3691F9f637aC";
const JWETH_ADDRESS = "0x929f5caB61DFEc79a5431a7734a68D714C4633fa";

const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
const LINK = "0x5947BB275c521040051D82396192181b413227A3";

describe("JoeLiquidator", function () {
  let joeLiquidatorContract;
  let joetrollerContract;
  let joeRouterContract;
  let jAVAXContract;
  let jLINKContract;
  let linkContract;

  let borrower;
  let liquidator;
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
      JUSDC_ADDRESS,
      JWETH_ADDRESS
    );

    joetrollerContract = await ethers.getContractAt("Joetroller", JOETROLLER_ADDRESS);
    joeRouterContract = await ethers.getContractAt("JoeRouter02", JOE_ROUTER_02_ADDRESS);
    jAVAXContract = await ethers.getContractAt("JWrappedNativeDelegator", JAVAX_ADDRESS);
    jLINKContract = await ethers.getContractAt("JCollateralCapErc20Delegator", JLINK_ADDRESS);
    linkContract = await ethers.getContractAt("ERC20", LINK);

    [borrower, liquidator, addr2] = await ethers.getSigners();
  });

  describe("Test liquidate native borrow position and ERC20 supply position", function () {
    it("Test liquidate native borrow position and LINK supply position", async function () {
      // Increase default timeout from 20s to 60s
      this.timeout(60000)

      // Following guide here: https://medium.com/compound-finance/borrowing-assets-from-compound-quick-start-guide-f5e69af4b8f4

      // Ensure liquidity and shortfall is 0 before we do anything
      const [errBeginning, liquidityBeginning, shortfallBeginning] =
        await joetrollerContract.getAccountLiquidity(borrower.address);
      expect(liquidityBeginning.eq(0)).to.equal(true);
      expect(shortfallBeginning.eq(0)).to.equal(true);

      /// 1. Swap AVAX for 100 LINK so that we can supply LINK to jLINK
      /// Notes: 
      /// - 18.9 AVAX ~= 100 LINK
      /// - AVAX is 18 decimals
      /// - LINK is 18 decimals

      // Swap more AVAX just to make sure we get at least 100 LINK in return
      const amountOfAVAXToSwap = ethers.utils.parseEther("30");
      const amountOfLINKToSupply = ethers.utils.parseEther("100");

      // Ensure that our LINK balance is 0 before the swap
      const linkBalanceBeforeSwap = await linkContract.balanceOf(borrower.address);
      expect(linkBalanceBeforeSwap.eq(0)).to.equal(true);

      // Perform the swap
      const currentBlock = await ethers.provider.getBlock();
      const swapAVAXForLINK = await joeRouterContract.connect(borrower).swapExactAVAXForTokens(
        amountOfLINKToSupply, // amountOutMin
        [WAVAX, LINK], // path
        borrower.address, // to
        currentBlock.timestamp + SECONDS_IN_MINUTE, // deadline
        { value: amountOfAVAXToSwap }
      );
      await swapAVAXForLINK.wait();

      // Ensure that our LINK balance after the swap is at least `amountOfLINKToSupply` LINK
      const linkBalanceAfterSwap = await linkContract.balanceOf(borrower.address);
      expect(linkBalanceAfterSwap.gte(amountOfLINKToSupply)).to.equal(true);

      /// 2. Supply 100 LINK to jLINK contract as collateral

      // Ensure our jLINK balance before supplying collateral is 0
      const jLINKBalanceUnderlyingBefore = await jLINKContract.balanceOfUnderlying(borrower.address);
      expect(jLINKBalanceUnderlyingBefore).to.equal(0);

      // Approve jLINK contract to take LINK
      const approveJLINKTxn = await linkContract.connect(borrower).approve(JLINK_ADDRESS, amountOfLINKToSupply)
      await approveJLINKTxn.wait();

      // Supply LINK to jLINK contract
      console.log("Supplying LINK as collateral to jLINK...");
      const mintLINKTxn = await jLINKContract.connect(borrower).mint(amountOfLINKToSupply);
      await mintLINKTxn.wait();

      // Ensure our jLINK balance after supplying collateral is greater than 0
      const jLINKBalanceUnderlyingAfter = await jLINKContract.balanceOfUnderlying(borrower.address);
      expect(jLINKBalanceUnderlyingAfter.gt(0)).to.equal(true);


      /// 3. Enter market via Joetroller for jLINK for using LINK as collateral
      expect(
        await joetrollerContract
          .checkMembership(borrower.address, JLINK_ADDRESS)
      ).to.equal(false);
      await joetrollerContract.connect(borrower).enterMarkets([JLINK_ADDRESS])
      expect(
        await joetrollerContract
          .checkMembership(borrower.address, JLINK_ADDRESS)
      ).to.equal(true);


      /// 4. Ensure account liquidity is greater than 0 and shortfall is 0 before borrow
      const [errBeforeBorrow, liquidityBeforeBorrow, shortfallBeforeBorrow] =
        await joetrollerContract.getAccountLiquidity(borrower.address);
      expect(liquidityBeforeBorrow.gt(0)).to.equal(true);
      expect(shortfallBeforeBorrow.eq(0)).to.equal(true);


      /// 5. Borrow AVAX from jAVAX contract.
      /// Notes: 
      /// - We supplied 100 LINK
      /// - Collateral factor of LINK is 0.6
      /// - 60 LINK ~= 11.36 AVAX so we should borrow 8 AVAX
      /// - AVAX has 18 decimals
      /// - LINK has 18 decimals

      // Confirm jAVAX borrowBalanceCurrent is 0 before we borrow
      const jNativeBorrowBalanceBefore = await jAVAXContract.borrowBalanceCurrent(borrower.address);
      expect(jNativeBorrowBalanceBefore).to.equal(0);

      // Borrow 8 AVAX from jAVAX contract
      console.log("Borrowing AVAX from jAVAX...");
      const amountOfNativeToBorrow = ethers.utils.parseEther("8");
      const borrowTxn = await jAVAXContract.connect(borrower).borrowNative(amountOfNativeToBorrow);
      await borrowTxn.wait();

      // Confirm jAVAX borrowBalanceCurrent after borrow is `amountOfNativeToBorrow` AVAX
      const jNativeBorrowBalanceAfter = await jAVAXContract.borrowBalanceCurrent(borrower.address);
      expect(jNativeBorrowBalanceAfter.eq(amountOfNativeToBorrow)).to.equal(true);

      // Confirm account liquidity is greater than 0 and shortfall is 0 right after the borrow
      const [errAfterBorrow, liquidityAfterBorrow, shortfallAfterBorrow] = await joetrollerContract.getAccountLiquidity(borrower.address);
      expect(liquidityAfterBorrow.gt(0)).to.equal(true);
      expect(shortfallAfterBorrow.eq(0)).to.equal(true);


      /// 6. Ensure borrow rate per second for jUSDT is greater than supply rate per
      /// second for jLINK.
      const jAVAXBorrowRatePerSecond = await jAVAXContract.borrowRatePerSecond();
      const jLINKSupplyRatePerSecond = await jLINKContract.supplyRatePerSecond();
      expect(jAVAXBorrowRatePerSecond.gt(jLINKSupplyRatePerSecond)).to.equal(true);


      /// 7. Since we confirmed borrow rate is greater than our supply rate, that means
      /// we can bring the account underwater // into shortfall by 
      /// - Increase time by long amount
      /// - Mine block
      /// - Accrue interest 
      /// Doing so will allow us to make the account liquidatable!
      console.log("Bringing account underwater by increasing time and accruing interest...");

      // Increase time and mine block
      await ethers.provider.send("evm_increaseTime", [SECONDS_IN_DAY * 30 * 12 * 10]);
      await ethers.provider.send("evm_mine");

      // Accrue interest. Note that we need to accrue interest for both the borrow and 
      // supply jToken, otherwise we run into this error in JToken#liquidateBorrowFresh:
      // https://github.com/traderjoe-xyz/joe-lending/blob/main/contracts/JToken.sol#L726-L732
      const accrueNativeInterestTxn = await jAVAXContract.accrueInterest();
      await accrueNativeInterestTxn.wait();

      const accrueJLINKInterestTxn = await jLINKContract.accrueInterest();
      await accrueJLINKInterestTxn.wait();

      // Confirm account liquidity is 0 and has non-zero shortfall after mining, 
      // i.e. can be liquidated 
      const [errAfterMining, liquidityAfterMining, shortfallAfterMining] = await joetrollerContract.getAccountLiquidity(borrower.address);
      expect(liquidityAfterMining.eq(0)).to.equal(true);
      expect(shortfallAfterMining.gt(0)).to.equal(true);


      /// 8. Liquidate account!
      console.log("Performing liquidation...");
      const jRepayTokenAddress = JAVAX_ADDRESS;
      const jSeizeTokenAddress = JLINK_ADDRESS;
      const liquidateTxn = await joeLiquidatorContract.connect(liquidator).liquidate(
        borrower.address, // borrowerToLiquidate
        jRepayTokenAddress, // jRepayTokenAddress
        jSeizeTokenAddress // jSeizeTokenAddress
      );
      const liquidationTxnReceipt = await liquidateTxn.wait();

      const liquidationTxnLogs = getTxnLogs(joeLiquidatorContract, liquidationTxnReceipt);

      // Expect JoeLiquidator#LiquidationEvent to be emitted
      expect(liquidationTxnLogs.length).to.equal(1);
      const liquidationEventLog = liquidationTxnLogs[0];
      expect(liquidationEventLog.name).to.equal('LiquidationEvent');

      // Expect that data from LiquidationEvent is correct
      const [
        borrowerLiquidatedFromEvent,
        jRepayTokenAddressFromEvent,
        jSeizeTokenAddressFromEvent,
        repayAmountFromEvent,
        profitedAvaxFromEvent,
        ...rest
      ] = liquidationEventLog.args;

      expect(borrowerLiquidatedFromEvent).to.equal(borrower.address);
      expect(jRepayTokenAddressFromEvent).to.equal(jRepayTokenAddress);
      expect(jSeizeTokenAddressFromEvent).to.equal(jSeizeTokenAddress);
      expect(repayAmountFromEvent.gt(0)).to.equal(true);
      expect(profitedAvaxFromEvent.gt(0)).to.equal(true);

      // Amount repaid was 17593918154301303822 and profited 0.995044465139119386 AVAX!
      console.log(
        `Successfully liquidated ${borrowerLiquidatedFromEvent} for jRepayToken ${jRepayTokenAddressFromEvent} ` +
        `and jSeizeToken ${jSeizeTokenAddressFromEvent}.`
      );
      console.log(
        `Amount repaid was ${repayAmountFromEvent} and profited ${ethers.utils.formatEther(profitedAvaxFromEvent)} AVAX!`
      );
    });
  });

});
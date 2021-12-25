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
const JWETH_ADDRESS = "0x929f5caB61DFEc79a5431a7734a68D714C4633fa";
const JUSDC_ADDRESS = "0xEd6AaF91a2B084bd594DBd1245be3691F9f637aC";

const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
const USDC = "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664";

xdescribe("JoeLiquidator", function () {
  let joeLiquidatorContract;
  let joetrollerContract;
  let joeRouterContract;
  let jAVAXContract;
  let jUSDCContract;
  let usdcContract;

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
    jUSDCContract = await ethers.getContractAt("JCollateralCapErc20Delegator", JUSDC_ADDRESS);
    jAVAXContract = await ethers.getContractAt("JWrappedNativeDelegator", JAVAX_ADDRESS);
    usdcContract = await ethers.getContractAt("ERC20", USDC);

    [borrower, liquidator, addr2] = await ethers.getSigners();
  });

  describe("Test liquidate ERC20 borrow position and native supply position", function () {
    it("Test liquidate USDC borrow position and native supply position", async function () {
      // Increase default timeout from 20s to 60s
      this.timeout(60000)

      // Following guide here: https://medium.com/compound-finance/borrowing-assets-from-compound-quick-start-guide-f5e69af4b8f4

      // Ensure liquidity and shortfall is 0 before we do anything
      const [errBeginning, liquidityBeginning, shortfallBeginning] = await joetrollerContract.getAccountLiquidity(borrower.address);
      expect(liquidityBeginning.eq(0)).to.equal(true);
      expect(shortfallBeginning.eq(0)).to.equal(true);

      /// 1. Supply 10 AVAX to jAVAX contract as collateral
      /// Notes: 
      /// - 1159.39 USDC ~= 10 AVAX
      /// - AVAX is 18 decimals
      /// - USDC is 6 decimals
      const amountOfAVAXToSupply = ethers.utils.parseEther("10");

      // Ensure our jAVAX balance before supplying collateral is 0
      const jAVAXBalanceUnderlyingBefore = await jAVAXContract.balanceOfUnderlying(borrower.address);
      expect(jAVAXBalanceUnderlyingBefore.eq(0)).to.equal(true);

      // Supply AVAX to jAVAX contract
      console.log("Supplying AVAX as collateral to jAVAX...");
      const mintJAVAXTxn = await jAVAXContract.connect(borrower).mintNative({ value: amountOfAVAXToSupply });
      await mintJAVAXTxn.wait();

      // Ensure our jAVAX balance after supplying collateral is greater than 0
      const jAVAXBalanceUnderlyingAfter = await jAVAXContract.balanceOfUnderlying(borrower.address);
      expect(jAVAXBalanceUnderlyingAfter.gt(0)).to.equal(true);

      /// 2. Enter market via Joetroller for jAVAX for using AVAX as collateral
      expect(
        await joetrollerContract
          .checkMembership(borrower.address, JAVAX_ADDRESS)
      ).to.equal(false);
      await joetrollerContract.connect(borrower).enterMarkets([JAVAX_ADDRESS])
      expect(
        await joetrollerContract
          .checkMembership(borrower.address, JAVAX_ADDRESS)
      ).to.equal(true);


      /// 3. Ensure account liquidity is greater than 0 and shortfall is 0 before borrow
      const [errBeforeBorrow, liquidityBeforeBorrow, shortfallBeforeBorrow] =
        await joetrollerContract.getAccountLiquidity(borrower.address);
      expect(liquidityBeforeBorrow.gt(0)).to.equal(true);
      expect(shortfallBeforeBorrow.eq(0)).to.equal(true);


      /// 4. Borrow USDC from jUSDC contract.
      /// Note: 
      /// - We supplied 10 AVAX
      /// - Collateral factor of AVAX is 0.75
      /// - 7.5 AVAX ~= 868.62 USDC so we should borrow 750 USDC
      /// - USDC has 6 decimals
      /// - AVAX has 18 decimals

      // Confirm jUSDC borrowBalanceCurrent is 0 before we borrow
      const jUSDCBorrowBalanceBefore = await jUSDCContract.borrowBalanceCurrent(borrower.address);
      expect(jUSDCBorrowBalanceBefore).to.equal(0);

      // Borrow 750 USDC from jUSDC contract
      console.log("Borrowing USDC from jUSDC...");
      const amountOfUSDCToBorrow = ethers.utils.parseUnits("750", 6);
      const borrowTxn = await jUSDCContract.connect(borrower).borrow(amountOfUSDCToBorrow);
      await borrowTxn.wait();

      // Confirm jUSDC borrowBalanceCurrent is `amountOfUSDCToBorrow` after we borrow
      const jUSDCBorrowBalanceAfter = await jUSDCContract.borrowBalanceCurrent(borrower.address);
      expect(jUSDCBorrowBalanceAfter.eq(amountOfUSDCToBorrow)).to.equal(true);

      // Confirm account liquidity is greater than 0 and shortfall is 0 right after the borrow
      const [errAfterBorrow, liquidityAfterBorrow, shortfallAfterBorrow] = await joetrollerContract.getAccountLiquidity(borrower.address);
      expect(liquidityAfterBorrow.gt(0)).to.equal(true);
      expect(shortfallAfterBorrow.eq(0)).to.equal(true);

      /// 5. Ensure borrow rate per second for jUSDC is greater than supply rate per
      /// second for jAVAX.
      const jUSDCBorrowRatePerSecond = await jUSDCContract.borrowRatePerSecond();
      const jAVAXSupplyRatePerSecond = await jAVAXContract.supplyRatePerSecond();
      expect(jUSDCBorrowRatePerSecond.gt(jAVAXSupplyRatePerSecond)).to.equal(true);

      /// 6. Since we confirmed borrow rate is greater than our supply rate, that means
      /// we can bring the account underwater // into shortfall by 
      /// - Increase time by long amount
      /// - Mine block
      /// - Accrue interest 
      /// Doing so will allow us to make the account liquidatable!
      console.log("Bringing account underwater by increasing time and accruing interest...");

      // Increase time and mine block
      await ethers.provider.send("evm_increaseTime", [SECONDS_IN_DAY * 30 * 12 * 80]);
      await ethers.provider.send("evm_mine");

      // Accrue interest. Note that we need to accrue interest for both the borrow and 
      // supply jToken, otherwise we run into this error in JToken#liquidateBorrowFresh:
      // https://github.com/traderjoe-xyz/joe-lending/blob/main/contracts/JToken.sol#L726-L732
      const accrueJUSDCInterestTxn = await jUSDCContract.accrueInterest();
      await accrueJUSDCInterestTxn.wait();

      const accrueNativeInterestTxn = await jAVAXContract.accrueInterest();
      await accrueNativeInterestTxn.wait();

      // Confirm account liquidity is 0 and has non-zero shortfall after mining, 
      // i.e. can be liquidated 
      const [errAfterMining, liquidityAfterMining, shortfallAfterMining] =
        await joetrollerContract.getAccountLiquidity(borrower.address);
      expect(liquidityAfterMining.eq(0)).to.equal(true);
      expect(shortfallAfterMining.gt(0)).to.equal(true);

      /// 7. Liquidate account!
      console.log("Performing liquidation...");
      const jRepayTokenAddress = JUSDC_ADDRESS;
      const jSeizeTokenAddress = JAVAX_ADDRESS;
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

      // Amount repaid was 864790133 and profited 0.42079229250805344 AVAX!
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
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
const JWETHE_ADDRESS = "0x929f5caB61DFEc79a5431a7734a68D714C4633fa";
const JUSDC_ADDRESS = "0xEd6AaF91a2B084bd594DBd1245be3691F9f637aC";

const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
const WETHE = "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB";
const WBTCE = "0x50b7545627a5162F82A992c33b87aDc75187B218";
const USDC = "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664";
const USDTE = "0xc7198437980c041c805A1EDcbA50c1Ce5db95118";
const DAIE = "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70";
const LINKE = "0x5947BB275c521040051D82396192181b413227A3";
const MIM = "0x130966628846BFd36ff31a822705796e8cb8C18D";

describe("JoeLiquidator", function () {
  let joeLiquidatorContract;
  let joetrollerContract;
  let joeRouterContract;
  let jAVAXContract;
  let jUSDCContract;
  let wavaxContract;
  let usdcContract;

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
      JUSDC_ADDRESS,
      JWETHE_ADDRESS
    );

    joetrollerContract = await ethers.getContractAt("Joetroller", JOETROLLER_ADDRESS);
    joeRouterContract = await ethers.getContractAt("JoeRouter02", JOE_ROUTER_02_ADDRESS);
    jUSDCContract = await ethers.getContractAt("JCollateralCapErc20Delegator", JUSDC_ADDRESS);
    jAVAXContract = await ethers.getContractAt("JWrappedNativeDelegator", JAVAX_ADDRESS);
    wavaxContract = await ethers.getContractAt("WAVAXInterface", WAVAX);
    usdcContract = await ethers.getContractAt("ERC20", USDC);

    [owner, addr1, addr2] = await ethers.getSigners();
  });

  describe("Test liquidate ERC20 borrow position and native supply position", function () {
    // Collateral factor of jUSDC (borrow): 0.8
    // Collateral factor of jAVAX (supply): 0.75
    // Queried by using Joetroller#markets(address _jTokenAddress) => Market
    it("Test liquidate USDC borrow position and native supply position", async function () {
      const currBlock = await ethers.provider.getBlock();
      console.log("CURRENT BLOCK NUMBER:", currBlock.number);

      // Increase default timeout from 20s to 60s
      this.timeout(60000)

      // Following guide here: https://medium.com/compound-finance/borrowing-assets-from-compound-quick-start-guide-f5e69af4b8f4

      const [errBeginning, liquidityBeginning, shortfallBeginning] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY BEGINNING:", liquidityBeginning);
      console.log("SHORTFUL BEGINNING:", shortfallBeginning);

      /// 1. Supply 10 AVAX to jAVAX contract as collateral
      /// Notes: 
      /// 1. 1159.39 USDC ~= 10 AVAX
      /// 2. AVAX is 18 decimals
      /// 3. USDC is 6 decimals
      const amountOfAVAXToSupply = ethers.utils.parseEther("10");

      const jAVAXBalanceUnderlyingBefore = await jAVAXContract.balanceOfUnderlying(owner.address);
      console.log("OWNER jAVAX BALANCE UNDERLYING BEFORE", jAVAXBalanceUnderlyingBefore);
      expect(jAVAXBalanceUnderlyingBefore.eq(0)).to.equal(true);

      // Supply AVAX to jAVAX contract
      console.log("Supplying AVAX as collateral to jAVAX...");
      const mintJAVAXTxn = await jAVAXContract.connect(owner).mintNative({ value: amountOfAVAXToSupply });
      await mintJAVAXTxn.wait();

      const jAVAXBalanceUnderlyingAfter = await jAVAXContract.balanceOfUnderlying(owner.address);
      console.log("OWNER jAVAX BALANCE UNDERLYING AFTER", jAVAXBalanceUnderlyingAfter);
      expect(jAVAXBalanceUnderlyingAfter.gt(0)).to.equal(true);

      /// 2. Enter market via Joetroller for jAVAX for using AVAX as collateral
      expect(
        await joetrollerContract
          .checkMembership(owner.address, JAVAX_ADDRESS)
      ).to.equal(false);
      await joetrollerContract.connect(owner).enterMarkets([JAVAX_ADDRESS])
      expect(
        await joetrollerContract
          .checkMembership(owner.address, JAVAX_ADDRESS)
      ).to.equal(true);


      /// 3. Get account liquidity in protocol before borrow
      const [errBeforeBorrow, liquidityBeforeBorrow, shortfallBeforeBorrow] =
        await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY BEFORE BORROW:", liquidityBeforeBorrow);
      console.log("SHORTFUL BEFORE BORROW:", shortfallBeforeBorrow);


      // /// 4. Fetch borrow rate per second for jUSDT.e
      // const jUSDTEBorrowRatePerSecond = await jUSDTEContract.borrowRatePerSecond();
      // expect(jUSDTEBorrowRatePerSecond.gt(0)).to.equal(true);
      // console.log("jUSDT.e BORROW RATE PER SECOND:", jUSDTEBorrowRatePerSecond);


      /// 6. Borrow USDC from jUSDC contract.
      /// Notes: 
      /// - We supplied 10 AVAX
      /// - Collateral factor of AVAX is 0.75
      /// - 868.62 USDC ~= 7.5 AVAX so we should borrow 750 USDC
      /// - USDC has 6 decimals
      /// - AVAX has 18 decimals

      // Confirm jUSDC borrowBalanceCurrent is 0 before we borrow
      const jUSDCBorrowBalanceBefore = await jUSDCContract.borrowBalanceCurrent(owner.address);
      console.log("jUSDC BORROW BALANCE BEFORE:", jUSDCBorrowBalanceBefore);
      expect(jUSDCBorrowBalanceBefore).to.equal(0);

      // Borrow 750 USDC from jUSDC contract
      console.log("Borrowing...");
      const amountOfUSDCToBorrow = ethers.utils.parseUnits("750", 6);
      const borrowTxn = await jUSDCContract.connect(owner).borrow(amountOfUSDCToBorrow);
      await borrowTxn.wait();

      // Confirm jAVAX borrowBalanceCurrent after borrow is 4 AVAX
      const jUSDCBorrowBalanceAfter = await jUSDCContract.borrowBalanceCurrent(owner.address);
      console.log("jUSDC BORROW BALANCE AFTER:", jUSDCBorrowBalanceAfter);
      expect(jUSDCBorrowBalanceAfter.eq(amountOfUSDCToBorrow)).to.equal(true);

      const [errAfterBorrow, liquidityAfterBorrow, shortfallAfterBorrow] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY AFTER BORROW:", liquidityAfterBorrow);
      console.log("SHORTFALL AFTER BORROW:", shortfallAfterBorrow);

      /// 7. Increase time, mine block, and accrue interest so that we can make account liquidatable!
      // 80
      await ethers.provider.send("evm_increaseTime", [SECONDS_IN_DAY * 30 * 12 * 80]);
      await ethers.provider.send("evm_mine");

      // Need to accrue interest for both the borrow and supply jToken, otherwise
      // we run into this error in JToken#liquidateBorrowFresh:
      // https://github.com/traderjoe-xyz/joe-lending/blob/main/contracts/JToken.sol#L726-L732
      const accrueJUSDCInterestTxn = await jUSDCContract.accrueInterest();
      await accrueJUSDCInterestTxn.wait();

      const accrueNativeInterestTxn = await jAVAXContract.accrueInterest();
      await accrueNativeInterestTxn.wait();

      const jUSDCBorrowBalanceAfterMining = await jUSDCContract.borrowBalanceCurrent(owner.address);
      console.log("jUSDC BORROW BALANCE AFTER MINING:", jUSDCBorrowBalanceAfterMining);

      // Confirm account has shortfall, a.k.a. can be liquidated 
      const [errAfterMining, liquidityAfterMining, shortfallAfterMining] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY AFTER MINING:", liquidityAfterMining);
      console.log("SHORTFALL AFTER MINING:", shortfallAfterMining);
      expect(liquidityAfterMining.eq(0)).to.equal(true);
      expect(shortfallAfterMining.gt(0)).to.equal(true);

      /// 8. Liquidate account!
      console.log("Starting liquidation...");
      const jRepayTokenAddress = JUSDC_ADDRESS;
      const jSeizeTokenAddress = JAVAX_ADDRESS;
      const liquidateTxn = await joeLiquidatorContract.connect(addr1).liquidate(
        owner.address, // borrowerToLiquidate
        jRepayTokenAddress, // jRepayTokenAddress
        jSeizeTokenAddress // jSeizeTokenAddress
      );
      const liquidationTxnReceipt = await liquidateTxn.wait();

      const liquidationTxnLogs = getTxnLogs(joeLiquidatorContract, liquidationTxnReceipt);

      expect(liquidationTxnLogs.length).to.equal(1);

      const liquidationEventLog = liquidationTxnLogs[0];

      expect(liquidationEventLog.name).to.equal('LiquidationEvent');

      const [
        borrowerLiquidatedFromEvent,
        jRepayTokenAddressFromEvent,
        jSeizeTokenAddressFromEvent,
        repayAmountFromEvent,
        profitedAvaxFromEvent,
        ...rest
      ] = liquidationEventLog.args;

      expect(borrowerLiquidatedFromEvent).to.equal(owner.address);
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
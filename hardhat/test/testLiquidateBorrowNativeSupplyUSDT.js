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

// Based on https://github.com/Sanghren/avalanche-hardhat-fork-tutorial
const AVALANCHE_NODE_URL = "https://api.avax.network/ext/bc/C/rpc";


use(solidity);

const ONLY_OWNER_ERROR_MSG = "Ownable: caller is not the owner";
const JOETROLLER_ADDRESS = "0xdc13687554205E5b89Ac783db14bb5bba4A1eDaC";
const JOE_ROUTER_02_ADDRESS = "0x60aE616a2155Ee3d9A68541Ba4544862310933d4";
const JAVAX_ADDRESS = "0xC22F01ddc8010Ee05574028528614634684EC29e";
const JWETHE_ADDRESS = "0x929f5caB61DFEc79a5431a7734a68D714C4633fa";
const JUSDCE_ADDRESS = "0xEd6AaF91a2B084bd594DBd1245be3691F9f637aC";
const JLINKE_ADDRESS = "0x585E7bC75089eD111b656faA7aeb1104F5b96c15";
const JUSDTE_ADDRESS = "0x8b650e26404AC6837539ca96812f0123601E4448";

const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
const WETHE = "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB";
const WBTCE = "0x50b7545627a5162F82A992c33b87aDc75187B218";
const USDCE = "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664";
const USDTE = "0xc7198437980c041c805A1EDcbA50c1Ce5db95118";
const DAIE = "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70";
const LINKE = "0x5947BB275c521040051D82396192181b413227A3";
const MIM = "0x130966628846BFd36ff31a822705796e8cb8C18D";

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

xdescribe("JoeLiquidator", function () {
  let joeLiquidatorContract;
  let joetrollerContract;
  let joeRouterContract;
  let jAVAXContract;
  let jLINKEContract;
  let jUSDTEContract;
  let wavaxContract;
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
    jAVAXContract = await ethers.getContractAt("JWrappedNativeDelegator", JAVAX_ADDRESS);
    jLINKEContract = await ethers.getContractAt("JCollateralCapErc20Delegator", JLINKE_ADDRESS);
    jUSDTEContract = await ethers.getContractAt("JCollateralCapErc20Delegator", JUSDTE_ADDRESS);
    wavaxContract = await ethers.getContractAt("WAVAXInterface", WAVAX);
    linkeContract = await ethers.getContractAt("ERC20", LINKE);
    usdteContract = await ethers.getContractAt("ERC20", USDTE);

    [owner, addr1, addr2] = await ethers.getSigners();
  });

  describe("Test liquidate native borrow position and ERC20 supply position", function () {
    // Following guide here: https://medium.com/compound-finance/borrowing-assets-from-compound-quick-start-guide-f5e69af4b8f4
    it("Test liquidate native borrow position and USDT supply position", async function () {
      // Increase default timeout from 20s to 60s
      this.timeout(60000)

      const [errBeginning, liquidityBeginning, shortfallBeginning] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY BEGINNING:", liquidityBeginning);
      console.log("SHORTFUL BEGINNING:", shortfallBeginning);

      /// 0. Swap AVAX for 1000 USDT.e
      /// Note: 8.336 AVAX ~= 1000 USDT.e
      /// Note: USDT.e is 6 decimals
      const amountOfAVAXToSwap = ethers.utils.parseEther("10");
      const amountOfUSDTEToSupply = ethers.utils.parseUnits("1000", 6);

      const usdteBalanceBeforeSwap = await usdteContract.balanceOf(owner.address);
      expect(usdteBalanceBeforeSwap.eq(0)).to.equal(true);
      console.log("USDTE BALANCE BEFORE SWAP:", usdteBalanceBeforeSwap);

      const currentBlock = await ethers.provider.getBlock();
      const swapAVAXForUSDTE = await joeRouterContract.connect(owner).swapExactAVAXForTokens(
        amountOfUSDTEToSupply, // amountOutMin
        [WAVAX, USDTE], // path
        owner.address, // to
        currentBlock.timestamp + SECONDS_IN_MINUTE, // deadline
        { value: amountOfAVAXToSwap }
      );
      await swapAVAXForUSDTE.wait();

      const usdteBalanceAfterSwap = await usdteContract.balanceOf(owner.address);
      expect(usdteBalanceAfterSwap.gt(0)).to.equal(true);
      console.log("USDTE BALANCE AFTER SWAP:", usdteBalanceAfterSwap);

      /// 1. Supply 1000 USDT.e to jUSDT contract as collateral
      const jUSDTEBalanceUnderlyingBefore = await jUSDTEContract.balanceOfUnderlying(owner.address);
      console.log("OWNER jUSDT.e BALANCE UNDERLYING BEFORE", jUSDTEBalanceUnderlyingBefore);
      expect(jUSDTEBalanceUnderlyingBefore).to.equal(0);

      // Approve jUSDT.e contract to take USDT.e
      const approveJUSDTETxn = await usdteContract.connect(owner).approve(JUSDTE_ADDRESS, amountOfUSDTEToSupply)
      await approveJUSDTETxn.wait();

      // Supply USDT.e to jUDST.e contract
      const mintUSDTETxn = await jUSDTEContract.connect(owner).mint(amountOfUSDTEToSupply);
      await mintUSDTETxn.wait();
      console.log("Supplying USDT.e as collateral to jUSDT.e...");

      const jUSDTEBalanceUnderlyingAfter = await jUSDTEContract.balanceOfUnderlying(owner.address);
      console.log("OWNER jUSDT.e BALANCE UNDERLYING AFTER", jUSDTEBalanceUnderlyingAfter);
      expect(jUSDTEBalanceUnderlyingAfter.gt(0)).to.equal(true);

      /// 2. Enter market via Joetroller for jUSDT.e for using USDT.e as collateral
      expect(
        await joetrollerContract
          .checkMembership(owner.address, JUSDTE_ADDRESS)
      ).to.equal(false);
      await joetrollerContract.connect(owner).enterMarkets([JUSDTE_ADDRESS])
      expect(
        await joetrollerContract
          .checkMembership(owner.address, JUSDTE_ADDRESS)
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


      // 5. Get jUSDTE collateral factor. Queried by using Joetroller#markets(address _jTokenAddress) => Market
      const jUSDTECollateralFactor = 0.8;


      /// 6. Borrow USDT.e from jUSDT.e contract.
      /// Note: 
      /// 1. 6.633 AVAX ~= 800 USDT.e so we should borrow 11 USDT.e
      /// 2. AVAX has 18 decimals
      /// 3. USDT.e has 6 decimals

      // Confirm jUSDT.e borrowBalanceCurrent is 0 before we borrow
      const jNativeBorrowBalanceBefore = await jAVAXContract.borrowBalanceCurrent(owner.address);
      console.log("jAVAX BORROW BALANCE BEFORE:", jNativeBorrowBalanceBefore);
      expect(jNativeBorrowBalanceBefore).to.equal(0);

      // Borrow 5 AVAX from jAVAX contract
      console.log("Borrowing...");
      const amountOfNativeToBorrow = ethers.utils.parseEther("5");
      const borrowTxn = await jAVAXContract.connect(owner).borrowNative(amountOfNativeToBorrow);
      // Have to call `wait` to get transaction mined.
      await borrowTxn.wait();

      // Confirm jAVAX borrowBalanceCurrent after borrow is 5 AVAX
      const jNativeBorrowBalanceAfter = await jAVAXContract.borrowBalanceCurrent(owner.address);
      console.log("jAVAX BORROW BALANCE AFTER:", jNativeBorrowBalanceAfter);
      expect(jNativeBorrowBalanceAfter.eq(amountOfNativeToBorrow)).to.equal(true);

      const [errAfterBorrow, liquidityAfterBorrow, shortfallAfterBorrow] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY AFTER BORROW:", liquidityAfterBorrow);
      console.log("SHORTFALL AFTER BORROW:", shortfallAfterBorrow);

      /// 7. Increase time, mine block, and accrue interest so that we can make account liquidatable!
      await ethers.provider.send("evm_increaseTime", [SECONDS_IN_DAY * 30 * 12 * 10]);
      await ethers.provider.send("evm_mine");

      const accrueNativeInterestTxn = await jAVAXContract.accrueInterest();
      await accrueNativeInterestTxn.wait();

      const accrueUSDTEInterestTxn = await jUSDTEContract.accrueInterest();
      await accrueUSDTEInterestTxn.wait();

      const jNativeBorrowBalanceAfterMining = await jAVAXContract.borrowBalanceCurrent(owner.address);
      console.log("jAVAX BORROW BALANCE AFTER MINING:", jNativeBorrowBalanceAfterMining);

      // Confirm account has shortfall, a.k.a. can be liquidated 
      const [errAfterMining, liquidityAfterMining, shortfallAfterMining] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY AFTER MINING:", liquidityAfterMining);
      console.log("SHORTFALL AFTER MINING:", shortfallAfterMining);
      expect(liquidityAfterMining.eq(0)).to.equal(true);
      expect(shortfallAfterMining.gt(0)).to.equal(true);

      /// 8. Liquidate account!
      console.log("Starting liquidation...");
      const jRepayTokenAddress = JAVAX_ADDRESS;
      const jSeizeTokenAddress = JUSDTE_ADDRESS;
      const liquidateTxn = await joeLiquidatorContract.connect(addr1).liquidate(
        owner.address, // borrowerToLiquidate
        jRepayTokenAddress, // jRepayTokenAddress
        jSeizeTokenAddress // jSeizeTokenAddress
      );
      const liquidationTxnReceipt = await liquidateTxn.wait();
      console.log("LIQUIDATION RECEIPT:", liquidationTxnReceipt);

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
      console.log(liquidationEventLog.args);

      expect(borrowerLiquidatedFromEvent).to.equal(owner.address);
      expect(jRepayTokenAddressFromEvent).to.equal(jRepayTokenAddress);
      expect(jSeizeTokenAddressFromEvent).to.equal(jSeizeTokenAddress);
      expect(repayAmountFromEvent.gt(0)).to.equal(true);
      expect(profitedAvaxFromEvent.gt(0)).to.equal(true);

      // Amount repaid was 
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
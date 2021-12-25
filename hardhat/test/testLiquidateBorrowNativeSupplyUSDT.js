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
const JMIM_ADDRESS = "0xcE095A9657A02025081E0607c8D8b081c76A75ea";
const JWETHE_ADDRESS = "0x929f5caB61DFEc79a5431a7734a68D714C4633fa";
const JUSDCE_ADDRESS = "0xEd6AaF91a2B084bd594DBd1245be3691F9f637aC";

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

describe("JoeLiquidator", function () {
  let joeLiquidatorContract;
  let joetrollerContract;
  let joeRouterContract;
  let jAVAXContract;
  let jMIMContract;
  let wavaxContract;
  let mimContract;

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
    jMIMContract = await ethers.getContractAt("JCollateralCapErc20Delegator", JMIM_ADDRESS);
    wavaxContract = await ethers.getContractAt("WAVAXInterface", WAVAX);
    mimContract = await ethers.getContractAt("ERC20", MIM);

    [owner, addr1, addr2] = await ethers.getSigners();
  });

  describe("Test liquidate native borrow position and ERC20 supply position", function () {
    // Collateral factor of jAVAX (borrow): 0.75
    // Collateral factor of jMIM (supply): 0.6
    // Queried by using Joetroller#markets(address _jTokenAddress) => Market
    it("Test liquidate native borrow position and MIM supply position", async function () {
      // Increase default timeout from 20s to 60s
      this.timeout(60000)

      // Following guide here: https://medium.com/compound-finance/borrowing-assets-from-compound-quick-start-guide-f5e69af4b8f4

      const [errBeginning, liquidityBeginning, shortfallBeginning] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY BEGINNING:", liquidityBeginning);
      console.log("SHORTFUL BEGINNING:", shortfallBeginning);

      /// 0. Swap AVAX for 1000 MIM
      /// Notes: 
      /// 1. 8.763 AVAX ~= 1000 MIM
      /// 2. AVAX is 18 decimals
      /// 3. MIM is 18 decimals
      const amountOfAVAXToSwap = ethers.utils.parseEther("10");
      const amountOfMIMToSupply = ethers.utils.parseEther("1000");

      const mimBalanceBeforeSwap = await mimContract.balanceOf(owner.address);
      expect(mimBalanceBeforeSwap.eq(0)).to.equal(true);
      console.log("MIM BALANCE BEFORE SWAP:", mimBalanceBeforeSwap);

      const currentBlock = await ethers.provider.getBlock();
      const swapAVAXForMIM = await joeRouterContract.connect(owner).swapExactAVAXForTokens(
        amountOfMIMToSupply, // amountOutMin
        [WAVAX, MIM], // path
        owner.address, // to
        currentBlock.timestamp + SECONDS_IN_MINUTE, // deadline
        { value: amountOfAVAXToSwap }
      );
      await swapAVAXForMIM.wait();

      const mimBalanceAfterSwap = await mimContract.balanceOf(owner.address);
      expect(mimBalanceAfterSwap.gt(0)).to.equal(true);
      console.log("MIM BALANCE AFTER SWAP:", mimBalanceAfterSwap);

      /// 1. Supply 1000 MIM to jMIM contract as collateral
      const jMIMBalanceUnderlyingBefore = await jMIMContract.balanceOfUnderlying(owner.address);
      console.log("OWNER jMIM BALANCE UNDERLYING BEFORE", jMIMBalanceUnderlyingBefore);
      expect(jMIMBalanceUnderlyingBefore).to.equal(0);

      // Approve jUSDT.e contract to take USDT.e
      const approveJMIMTxn = await mimContract.connect(owner).approve(JMIM_ADDRESS, amountOfMIMToSupply)
      await approveJMIMTxn.wait();

      // Supply MIM to jMIM contract
      const mintMIMTxn = await jMIMContract.connect(owner).mint(amountOfMIMToSupply);
      await mintMIMTxn.wait();
      console.log("Supplying MIM as collateral to jMIM...");

      const jMIMBalanceUnderlyingAfter = await jMIMContract.balanceOfUnderlying(owner.address);
      console.log("OWNER jMIM BALANCE UNDERLYING AFTER", jMIMBalanceUnderlyingAfter);
      expect(jMIMBalanceUnderlyingAfter.gt(0)).to.equal(true);

      /// 2. Enter market via Joetroller for jUSDT.e for using USDT.e as collateral
      expect(
        await joetrollerContract
          .checkMembership(owner.address, JMIM_ADDRESS)
      ).to.equal(false);
      await joetrollerContract.connect(owner).enterMarkets([JMIM_ADDRESS])
      expect(
        await joetrollerContract
          .checkMembership(owner.address, JMIM_ADDRESS)
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


      /// 6. Borrow AVAX from jAVAX contract.
      /// Notes: 
      /// - We supplied 1000 MIM
      /// - Collateral factor of MIM is 0.6
      /// - 5.23 AVAX ~= 600 MIM so we should borrow 4 AVAX
      /// - AVAX has 18 decimals
      /// - MIM has 18 decimals

      // Confirm jAVAX borrowBalanceCurrent is 0 before we borrow
      const jNativeBorrowBalanceBefore = await jAVAXContract.borrowBalanceCurrent(owner.address);
      console.log("jAVAX BORROW BALANCE BEFORE:", jNativeBorrowBalanceBefore);
      expect(jNativeBorrowBalanceBefore).to.equal(0);

      // Borrow 4 AVAX from jAVAX contract
      console.log("Borrowing...");
      const amountOfNativeToBorrow = ethers.utils.parseEther("4");
      const borrowTxn = await jAVAXContract.connect(owner).borrowNative(amountOfNativeToBorrow);
      await borrowTxn.wait();

      // Confirm jAVAX borrowBalanceCurrent after borrow is 4 AVAX
      const jNativeBorrowBalanceAfter = await jAVAXContract.borrowBalanceCurrent(owner.address);
      console.log("jAVAX BORROW BALANCE AFTER:", jNativeBorrowBalanceAfter);
      expect(jNativeBorrowBalanceAfter.eq(amountOfNativeToBorrow)).to.equal(true);

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
      const accrueNativeInterestTxn = await jAVAXContract.accrueInterest();
      await accrueNativeInterestTxn.wait();

      const accrueJMIMInterestTxn = await jMIMContract.accrueInterest();
      await accrueJMIMInterestTxn.wait();

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
      const jSeizeTokenAddress = JMIM_ADDRESS;
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
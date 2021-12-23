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


describe("JoeLiquidator", function () {
  let joeLiquidatorContract;
  let joetrollerContract;
  let joeRouterContract;
  let jAVAXContract;
  let jLINKEContract;
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
      JAVAX_ADDRESS,
      JWETHE_ADDRESS
    );

    joetrollerContract = await ethers.getContractAt("Joetroller", JOETROLLER_ADDRESS);
    joeRouterContract = await ethers.getContractAt("JoeRouter02", JOE_ROUTER_02_ADDRESS);
    jAVAXContract = await ethers.getContractAt("JWrappedNativeDelegator", JAVAX_ADDRESS);
    jLINKEContract = await ethers.getContractAt("JCollateralCapErc20Delegator", JLINKE_ADDRESS);
    wavaxContract = await ethers.getContractAt("WAVAXInterface", WAVAX);
    linkeContract = await ethers.getContractAt("ERC20", LINKE);

    [owner, addr1, addr2] = await ethers.getSigners();
  });

  describe("Test liquidation", function () {
    // Following guide here: https://medium.com/compound-finance/borrowing-assets-from-compound-quick-start-guide-f5e69af4b8f4
    it("Take out loan position", async function () {
      const ownerBalance = await ethers.provider.getBalance(owner.address);
      console.log("OWNER BALANCE:", ownerBalance);

      /// 0. Swap AVAX for 1 LINK.e
      /// Note: 0.165 AVAX ~= 1 LINK.e
      const amountOfAVAXToSwap = ethers.utils.parseEther("0.5");

      // Deposit 0.5 AVAX to WAVAX 
      const wavaxBalanceBeforeDeposit = await wavaxContract.balanceOf(owner.address);
      console.log("WAVAX BALANCE BEFORE DEPOSIT:", wavaxBalanceBeforeDeposit);
      expect(wavaxBalanceBeforeDeposit.eq(0)).to.equal(true);

      const wavaxDepositTxn = await wavaxContract.connect(owner).deposit({ value: amountOfAVAXToSwap });
      await wavaxDepositTxn.wait();

      const wavaxBalanceAfterDeposit = await wavaxContract.balanceOf(owner.address);
      console.log("WAVAX BALANCE AFTER DEPOSIT:", wavaxBalanceAfterDeposit);
      expect(wavaxBalanceAfterDeposit.eq(amountOfAVAXToSwap)).to.equal(true);

      // Approve JoeRouter 0.5 WAVAX
      const approveJoeRouterWAVAXTxn = await wavaxContract.connect(owner).approve(JOE_ROUTER_02_ADDRESS, amountOfAVAXToSwap);
      await approveJoeRouterWAVAXTxn.wait();
      console.log("Approved JoeRouter in WAVAX...");

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

      return;

      /// 1. Supply 1 AVAX to jAVAX contract as collateral and obtain jAVAX in return
      const javaxBalanceBefore = await jAVAXContract.balanceOf(owner.address);
      expect(javaxBalanceBefore).to.equal(0);

      console.log("OWNER JAVAX BALANCE BEFORE", javaxBalanceBefore);

      // Note: AVAX is 18 decimals
      // const amountOfAVAXToSupply = ethers.utils.parseUnits("1", 8);
      const amountOfAVAXToSupply = ethers.utils.parseEther("1");
      const mintNativeTxn = await jAVAXContract.connect(owner).mintNative({ value: amountOfAVAXToSupply });
      await mintNativeTxn.wait();

      const javaxBalanceAfter = await jAVAXContract.balanceOf(owner.address);
      console.log("OWNER JAVAX BALANCE AFTER", javaxBalanceAfter);
      expect(javaxBalanceAfter.gt(0)).to.equal(true);

      /// 2. Enter market via Joetroller for jAVAX for AVAX as collateral
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
      const [errBeforeBorrow, liquidityBeforeBorrow, shortfallBeforeBorrow] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY BEFORE BORROW:", liquidityBeforeBorrow);
      console.log("SHORTFUL BEFORE BORROW:", shortfallBeforeBorrow);

      /// 4. Fetch borrow rate per second for jLINKE
      const jLINKEBorrowRatePerSecond = await jLINKEContract.borrowRatePerSecond();
      expect(jLINKEBorrowRatePerSecond.gt(0)).to.equal(true);
      console.log("jLINKE BORROW RATE PER SECOND:", jLINKEBorrowRatePerSecond);

      /// 5. Get jAVAX collateral factor. Queried by using Joetroller#markets(address _jTokenAddress) => Market
      const jAVAXCollateralFactor = 0.75;

      /// 6. Borrow LINK.e from jLINKE contract.
      /// Note: 
      /// 1. 0.75 AVAX ~= 4.4122 LINK.E so we should borrow 4.0 LINK.e
      /// 2. LINK.e has 18 decimals

      // Confirm jLINK.e borrowBalanceCurrent is 0 before we borrow
      const jLINKEBorrowBalanceBefore = await jLINKEContract.borrowBalanceCurrent(owner.address);
      console.log("jLINKE BORROW BALANCE BEFORE:", jLINKEBorrowBalanceBefore);
      expect(jLINKEBorrowBalanceBefore).to.equal(0);

      // Borrow 4.0 LINK.e from jLINK.e contract
      console.log("Borrowing...");
      // const amountOfLinkEToBorrow = ethers.utils.parseUnits("4", 8);
      const amountOfLinkEToBorrow = ethers.utils.parseEther("4.4", 18);
      const borrowTxn = await jLINKEContract.connect(owner).borrow(amountOfLinkEToBorrow);
      // Have to call `wait` to get transaction mined.
      await borrowTxn.wait();

      // Confirm jLINK.e borrowBalanceCurrent after borrow is 4.0 LINK.e
      const jLINKEBorrowBalanceAfter = await jLINKEContract.borrowBalanceCurrent(owner.address);
      console.log("jLINKE BORROW BALANCE AFTER:", jLINKEBorrowBalanceAfter);
      expect(jLINKEBorrowBalanceAfter.eq(amountOfLinkEToBorrow)).to.equal(true);

      const [errAfterBorrow, liquidityAfterBorrow, shortfallAfterBorrow] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY AFTER BORROW:", liquidityAfterBorrow);
      console.log("SHORTFALL AFTER BORROW:", shortfallAfterBorrow);

      /// 7. Increase time and mine block so that we can make account liquidatable!
      for (let i = 0; i < 1500; i++) {
        // console.log("MINING BLOCK:", i);
        let block = await ethers.provider.getBlock();
        let blockNumber = block.number;
        let blockTimeStamp = block.timestamp;
        console.log(`NUMBER: ${blockNumber}, TIMESTAMP: ${blockTimeStamp}`);
        await ethers.provider.send("evm_increaseTime", [SECONDS_IN_DAY * 30 * 12 * 100]);
        await ethers.provider.send("evm_mine");
      }

      const jLINKEBorrowBalanceAfterMining = await jLINKEContract.borrowBalanceCurrent(owner.address);
      console.log("jLINKE BORROW BALANCE AFTER MINING:", jLINKEBorrowBalanceAfterMining);

      // Confirm account has shortfall, a.k.a. can be liquidated 
      const [errAfterMining, liquidityAfterMining, shortfallAfterMining] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY AFTER MINING:", liquidityAfterMining);
      console.log("SHORTFALL AFTER MINING:", shortfallAfterMining);
    });

    xit("Take out loan and mine blocks until account health < 0", async function () {
      // ~ 999 AVAX
      // const ownerBalance = await ethers.provider.getBalance(owner.address);
      // console.log("OWNER BALANCE:", ownerBalance);

      const jLINKEContract = await ethers.getContractAt("JCollateralCapErc20Delegator", JLINKE_ADDRESS);

      // console.log(jLINKEContract)

      // const beforeProtocolBorrows = await jLINKEContract.totalBorrows();
      // console.log("BEFORE PROTOCOL BORROWS", beforeProtocolBorrows);

      const linkEContract = await ethers.getContractAt("ERC20", LINKE);
      const beforeOwnerBalance = await linkEContract.balanceOf(owner.address);
      console.log("BEFORE LINKE OWNER BALANCE", beforeOwnerBalance);

      // Take loan of 10 Link.e using AVAX as collateral (1 LINK.e ~= 0.168 AVAX)
      const tenLinkE = ethers.utils.parseUnits("10", 8);
      const borrowTxn = await jLINKEContract.connect(owner).borrow(tenLinkE);
      console.log(await borrowTxn.wait());

      // const afterProtocolBorrows = await jLINKEContract.totalBorrows();
      // console.log("AFTER PROTOCOL BORROWS", afterProtocolBorrows);

      const afterOwnerBalance = await linkEContract.balanceOf(owner.address);
      console.log("AFTER LINKE OWNER BALANCE", afterOwnerBalance);

    });
  });

  // describe("Test getAmountOfUSDCEToFlashLoan", function () {
  //   it("Calculate amount of USDC.e needed for 100 Link.e", async function () {
  //     // Assuming the borrow position to repay is 100 Link.e, we
  //     // expect to have to borrow 1905.81 USDC.e
  //     // ethers.utils.parseUnits("121.0", 9) => { BigNumber: "121000000000" }
  //     console.log(
  //       await joeLiquidatorContract.connect(owner).getAmountOfUSDCEToFlashLoan(
  //         joeLiquidatorContract.LINKE(),
  //         ethers.utils.parseEther("100")
  //       )
  //     );
  //   });
  // });

});
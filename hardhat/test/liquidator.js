const {
  ethers
} = require("hardhat");
const {
  use,
  expect
} = require("chai");
const {
  solidity
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


describe("JoeLiquidator", function () {
  let joeLiquidatorContract;
  let joetrollerContract;
  let joetrollerExtensionContract;
  let jAVAXContract;
  let jLINKEContract;

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
    joetrollerExtensionContract = await ethers.getContractAt("JoetrollerInterfaceExtension", JOETROLLER_ADDRESS);
    jAVAXContract = await ethers.getContractAt("JWrappedNativeDelegator", JAVAX_ADDRESS);
    jLINKEContract = await ethers.getContractAt("JCollateralCapErc20Delegator", JLINKE_ADDRESS);

    [owner, addr1, addr2] = await ethers.getSigners();
  });

  describe("Test liquidation", function () {
    // Following guide here: https://medium.com/compound-finance/borrowing-assets-from-compound-quick-start-guide-f5e69af4b8f4
    it("Take out loan position", async function () {
      /// 1. Supply 1 AVAX to jAVAX contract as collateral and obtain jAVAX in return
      const javaxBalanceBefore = await jAVAXContract.balanceOf(owner.address);
      expect(javaxBalanceBefore).to.equal(0);

      console.log("OWNER JAVAX BALANCE BEFORE", javaxBalanceBefore);

      const mintNativeTxn = await jAVAXContract.connect(owner).mintNative({ value: ethers.utils.parseEther("1") });
      await mintNativeTxn.wait()

      const javaxBalanceAfter = await jAVAXContract.balanceOf(owner.address);
      expect(javaxBalanceAfter.gt(0)).to.equal(true);
      console.log("OWNER JAVAX BALANCE AFTER", javaxBalanceAfter);

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

      /// 3. Get account liquidity in protocol
      const [err, liquidity, shortfall] = await joetrollerContract.getAccountLiquidity(owner.address);
      console.log("LIQUIDITY:", liquidity);

      /// 4. Fetch borrow rate per second for jLINKE
      const jLINKEBorrowRatePerSecond = await jLINKEContract.borrowRatePerSecond();
      expect(jLINKEBorrowRatePerSecond.gt(0)).to.equal(true);
      console.log("jLINKE BORROW RATE PER SECOND:", jLINKEBorrowRatePerSecond);

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
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

import "hardhat/console.sol";

import "./interfaces/ERC20Interface.sol";
import "./interfaces/ERC3156FlashBorrowerInterface.sol";
import "./interfaces/ERC3156FlashLenderInterface.sol";
import "./interfaces/WAVAXInterface.sol";
import "./lending/JTokenInterfaces.sol";
import "./lending/JoeRouter02.sol";
import "./lending/JoetrollerInterface.sol";
import "./lending/PriceOracle.sol";
import "./lending/Exponential.sol";
import "./libraries/SafeMath.sol";

contract JoeLiquidator is ERC3156FlashBorrowerInterface, Exponential {
    using SafeMath for uint256;

    /**
     * @notice Joetroller address
     */
    address public joetrollerAddress;
    address public joeRouter02Address;
    address public jUSDCEAddress;
    address public jWETHEAddress;

    address public constant WAVAX = 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7;
    address public constant WETHE = 0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB;
    address public constant WBTCE = 0x50b7545627a5162F82A992c33b87aDc75187B218;
    address public constant USDCE = 0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664;
    address public constant USDTE = 0xc7198437980c041c805A1EDcbA50c1Ce5db95118;
    address public constant DAIE = 0xd586E7F844cEa2F87f50152665BCbc2C279D8d70;
    address public constant LINKE = 0x5947BB275c521040051D82396192181b413227A3;
    address public constant MIM = 0x130966628846BFd36ff31a822705796e8cb8C18D;

    struct LiquidationData {
        address jRepayTokenAddress;
        address jSeizeTokenAddress;
        address borrowerToLiquidate;
        uint256 repayAmount;
    }

    event LiquidationEvent(
        address indexed _borrowerLiquidated,
        address _jRepayToken,
        address _jSeizeToken,
        uint256 _repayAmount,
        uint256 _profitedAVAX
    );

    constructor(
        address _joetrollerAddress,
        address _joeRouter02Address,
        address _jUSDCEAddress,
        address _jWETHEAddress
    ) {
        joetrollerAddress = _joetrollerAddress;
        joeRouter02Address = _joeRouter02Address;
        jUSDCEAddress = _jUSDCEAddress;
        jWETHEAddress = _jWETHEAddress;
    }

    modifier isLiquidatable(address _borrowerToLiquidate) {
        (, uint256 liquidity, ) = Joetroller(joetrollerAddress)
            .getAccountLiquidity(_borrowerToLiquidate);
        require(
            liquidity == 0,
            "JoeLiquidator: Cannot liquidate account with non-zero liquidity"
        );
        _;
    }

    function liquidate(
        address _borrowerToLiquidate,
        address _jRepayTokenAddress,
        address _jSeizeTokenAddress
    ) external isLiquidatable(_borrowerToLiquidate) {
        console.log("[JoeLiquidator] Calculating amount to pay...");
        uint256 amountToRepay = getAmountToRepay(
            _borrowerToLiquidate,
            _jRepayTokenAddress,
            _jSeizeTokenAddress
        );
        console.log(
            "[JoeLiquidator] Going to repay %d for token with address %s...",
            amountToRepay,
            _jRepayTokenAddress
        );
        doFlashloan(
            _borrowerToLiquidate,
            _jRepayTokenAddress,
            _jSeizeTokenAddress,
            amountToRepay
        );
    }

    function getAmountToRepay(
        address _borrowerToLiquidate,
        address _jRepayTokenAddress,
        address _jSeizeTokenAddress
    ) internal view returns (uint256) {
        Joetroller joetroller = Joetroller(joetrollerAddress);
        PriceOracle priceOracle = joetroller.oracle();

        console.log("[JoeLiquidator] Got joetroller and oracle...");

        uint256 closeFactor = joetroller.closeFactorMantissa();
        uint256 liquidationIncentive = joetroller
            .liquidationIncentiveMantissa();

        console.log(
            "[JoeLiquidator] Got close factor (%d) and liqudation incentive (%d)...",
            closeFactor,
            liquidationIncentive
        );

        uint256 repayTokenUnderlyingPrice = priceOracle.getUnderlyingPrice(
            JToken(_jRepayTokenAddress)
        );
        uint256 seizeTokenUnderlyingPrice = priceOracle.getUnderlyingPrice(
            JToken(_jSeizeTokenAddress)
        );

        console.log(
            "[JoeLiquidator] Got repay token underlying price (%d) and seize token underlying price (%d)...",
            repayTokenUnderlyingPrice,
            seizeTokenUnderlyingPrice
        );

        console.log(
            "[JoeLiquidator] Got current borrow balance (%d) and current seize balance (%d)...",
            JTokenInterface(_jRepayTokenAddress).borrowBalanceStored(
                _borrowerToLiquidate
            ),
            _getBalanceOfUnderlying(_jSeizeTokenAddress, _borrowerToLiquidate)
            // JTokenInterface(_jSeizeTokenAddress).balanceOfUnderlying(
            //     _borrowerToLiquidate
            // )
        );

        uint256 maxRepayAmount = (JTokenInterface(_jRepayTokenAddress)
            .borrowBalanceStored(_borrowerToLiquidate) * closeFactor) /
            uint256(10**18);
        uint256 maxSeizeAmount = (_getBalanceOfUnderlying(
            _jSeizeTokenAddress,
            _borrowerToLiquidate
        ) * liquidationIncentive) / uint256(10**18);

        console.log(
            "[JoeLiquidator] Got max repay and seize amounts...",
            repayTokenUnderlyingPrice,
            seizeTokenUnderlyingPrice
        );

        uint256 maxRepayAmountInUSD = maxRepayAmount *
            repayTokenUnderlyingPrice;
        uint256 maxSeizeAmountInUSD = maxSeizeAmount *
            seizeTokenUnderlyingPrice;

        uint256 maxAmountInUSD = (maxRepayAmountInUSD < maxSeizeAmountInUSD)
            ? maxRepayAmountInUSD
            : maxSeizeAmountInUSD;

        console.log(
            "[JoeLiquidator] Got max amount in USD...",
            repayTokenUnderlyingPrice,
            seizeTokenUnderlyingPrice
        );

        return maxAmountInUSD / repayTokenUnderlyingPrice;
    }

    /**
     * @notice Perform flash loan for given jToken and amount
     * @param _borrowerToLiquidate The address of the borrower to liquidate
     * @param _jRepayTokenAddress The address of the jToken contract to borrow from
     * @param _jSeizeTokenAddress The address of the jToken contract to seize collateral from
     * @param _repayAmount The amount of the tokens to repay
     */
    function doFlashloan(
        address _borrowerToLiquidate,
        address _jRepayTokenAddress,
        address _jSeizeTokenAddress,
        uint256 _repayAmount
    ) internal {
        address underlyingRepayToken = JErc20Storage(_jRepayTokenAddress)
            .underlying();
        bool isRepayTokenUSDCE = underlyingRepayToken == USDCE;

        uint256 flashLoanAmount = _getFlashLoanAmount(
            underlyingRepayToken,
            _repayAmount,
            isRepayTokenUSDCE
        );

        // We will only ever flash loan from jUSDC or jWETH
        JCollateralCapErc20Delegator jTokenToFlashLoan = _getJTokenToFlashLoan(
            isRepayTokenUSDCE
        );

        bytes memory data = abi.encode(
            msg.sender, // initiator
            _borrowerToLiquidate, // borrowerToLiquidate
            _jRepayTokenAddress, // jRepayTokenAddress
            _jSeizeTokenAddress, // jSeizeTokenAddress
            jTokenToFlashLoan.underlying(), // flashLoanedTokenAddress
            flashLoanAmount, // flashLoanAmount
            _repayAmount // repayAmount
        );

        jTokenToFlashLoan.flashLoan(this, msg.sender, flashLoanAmount, data);
    }

    /**
     * @notice Called by FlashLoanLender once flashloan is approved
     * @param _initiator The address that initiated this flash loan
     * @param _flashLoanTokenAddress The address of the underlying token contract borrowed from
     * @param _flashLoanAmount The amount of the tokens borrowed
     * @param _flashLoanFee The fee for this flash loan
     * @param _data The encoded data used for this flash loan
     */
    function onFlashLoan(
        address _initiator,
        address _flashLoanTokenAddress,
        uint256 _flashLoanAmount,
        uint256 _flashLoanFee,
        bytes calldata _data
    ) external override returns (bytes32) {
        require(
            Joetroller(joetrollerAddress).isMarketListed(msg.sender),
            "JoeLiquidator: Untrusted message sender calling onFlashLoan"
        );
        console.log("[JoeLiquidator] onFlashLoan was called by:");
        console.logAddress(msg.sender);
        console.log("[JoeLiquidator] The flash loan token address is:");
        console.logAddress(_flashLoanTokenAddress);

        LiquidationData memory liquidationData = _getLiquidationData(
            _initiator,
            _flashLoanTokenAddress,
            _flashLoanAmount,
            _data
        );

        uint256 flashLoanAmountToRepay = _flashLoanAmount.add(_flashLoanFee);

        // ********************************************************************
        // Our custom logic begins here...
        // ********************************************************************

        JErc20Interface jRepayToken = JErc20Interface(
            liquidationData.jRepayTokenAddress
        );

        // Swap token that we flash loaned (e.g. USDC.e) to the underlying repay token
        _swapFlashLoanTokenToRepayToken(
            _flashLoanTokenAddress,
            _flashLoanAmount,
            jRepayToken.underlying(),
            liquidationData.repayAmount
        );

        // Perform liquidation using underlying repay token and receive jSeizeTokens in return.
        _liquidateBorrow(
            jRepayToken,
            liquidationData.borrowerToLiquidate,
            liquidationData.repayAmount,
            JTokenInterface(liquidationData.jSeizeTokenAddress)
        );

        // Redeem jSeizeTokens for underlying seize tokens
        _redeemSeizeToken(liquidationData.jSeizeTokenAddress);

        // Swap seize token to flash loan token so we can repay flash loan
        _swapSeizeTokenToFlashLoanToken(
            liquidationData.jSeizeTokenAddress,
            _flashLoanTokenAddress,
            flashLoanAmountToRepay
        );

        // Convert any remaining seized token to native AVAX and send
        // to liquidator
        uint256 profitedAVAX = _swapRemainingSeizedTokenToAVAX(
            _initiator,
            liquidationData.jSeizeTokenAddress
        );

        emit LiquidationEvent(
            liquidationData.borrowerToLiquidate,
            liquidationData.jRepayTokenAddress,
            liquidationData.jSeizeTokenAddress,
            liquidationData.repayAmount,
            profitedAVAX
        );

        // ********************************************************************
        // Our custom logic ends here...
        // ********************************************************************

        // Approve flash loan lender to retrieve loan amount + fee from us
        _approveFlashLoanToken(_flashLoanTokenAddress, flashLoanAmountToRepay);

        return keccak256("ERC3156FlashBorrowerInterface.onFlashLoan");
    }

    function _getLiquidationData(
        address _initiator,
        address _flashLoanTokenAddress,
        uint256 _flashLoanAmount,
        bytes calldata _data
    ) internal pure returns (LiquidationData memory) {
        (
            address initiator,
            address borrowerToLiquidate,
            address jRepayTokenAddress,
            address jSeizeTokenAddress,
            address flashLoanedTokenAddress,
            uint256 flashLoanAmount,
            uint256 repayAmount
        ) = abi.decode(
                _data,
                (address, address, address, address, address, uint256, uint256)
            );

        // Validate encoded data
        require(
            _initiator == initiator,
            "JoeLiquidator: Untrusted loan initiator"
        );
        require(
            _flashLoanTokenAddress == flashLoanedTokenAddress,
            "JoeLiquidator: Encoded data (flashLoanedTokenAddress) does not match"
        );
        require(
            _flashLoanAmount == flashLoanAmount,
            "JoeLiquidator: Encoded data (flashLoanAmount) does not match"
        );

        LiquidationData memory liquidationData = LiquidationData({
            borrowerToLiquidate: borrowerToLiquidate,
            jRepayTokenAddress: jRepayTokenAddress,
            jSeizeTokenAddress: jSeizeTokenAddress,
            repayAmount: repayAmount
        });
        return liquidationData;
    }

    function _swapRemainingSeizedTokenToAVAX(
        address _initiator,
        address _jSeizeTokenAddress
    ) internal returns (uint256) {
        JErc20Storage jSeizeToken = JErc20Storage(_jSeizeTokenAddress);
        address jSeizeTokenUnderlyingAddress = jSeizeToken.underlying();

        // Swap seized token to AVAX
        ERC20 seizeToken = ERC20(jSeizeTokenUnderlyingAddress);
        uint256 remainingSeizeAmount = seizeToken.balanceOf(address(this));

        require(
            remainingSeizeAmount > 0,
            "JoeLiquidator: Expected to have remaining seize amount in order to have profited from liquidation"
        );

        console.log(
            "[JoeLiquidator] We have %d remaining seize tokens to swap to AVAX...",
            remainingSeizeAmount
        );

        seizeToken.approve(joeRouter02Address, remainingSeizeAmount);

        address[] memory swapPath = new address[](2);
        swapPath[0] = jSeizeTokenUnderlyingAddress;
        swapPath[1] = WAVAX;

        uint256[] memory amounts = JoeRouter02(joeRouter02Address)
            .swapExactTokensForAVAX(
                remainingSeizeAmount, // amountIn
                0, // amountOutMin
                swapPath, // path
                _initiator, // to
                block.timestamp // deadline
            );

        console.log(
            "[JoeLiquidator] Successfully transferred all profitted AVAX! (%d, %d)",
            amounts[0],
            amounts[1]
        );

        // Return profitted AVAX
        return amounts[1];
    }

    function _swapSeizeTokenToFlashLoanToken(
        address _jSeizeTokenAddress,
        address _flashLoanTokenAddress,
        uint256 _flashLoanAmountToRepay
    ) internal {
        console.log(
            "[JoeLiquidator] Swapping seize tokens to flash tokens to repay flash loan total (%d)...",
            _flashLoanAmountToRepay
        );
        JErc20Storage jSeizeToken = JErc20Storage(_jSeizeTokenAddress);
        address jSeizeTokenUnderlyingAddress = jSeizeToken.underlying();

        // Calculate amount of underlying seize token we need
        // to swap in order to pay back the flash loan amount + fee
        address[] memory swapPath = new address[](2);
        swapPath[0] = jSeizeTokenUnderlyingAddress;
        swapPath[1] = _flashLoanTokenAddress;

        console.log(
            "[JoeLiquidator] Calculating amount of seize token to swap with path:"
        );
        console.logAddress(jSeizeTokenUnderlyingAddress);
        console.logAddress(_flashLoanTokenAddress);

        uint256 amountOfSeizeTokenToSwap = JoeRouter02(joeRouter02Address)
            .getAmountsIn(_flashLoanAmountToRepay, swapPath)[0];

        console.log(
            "[JoeLiquidator] Amount of seize tokens to swap to flash token (%d)...",
            amountOfSeizeTokenToSwap
        );

        // Approve router to transfer `amountOfSeizeTokenToSwap` underlying
        // seize tokens
        ERC20 seizeToken = ERC20(jSeizeTokenUnderlyingAddress);
        seizeToken.approve(joeRouter02Address, amountOfSeizeTokenToSwap);

        console.log(
            "[JoeLiquidator] Amount of seize tokens we possess (%d)...",
            seizeToken.balanceOf(address(this))
        );

        // Swap seized token to flash loan token
        JoeRouter02(joeRouter02Address).swapExactTokensForTokens(
            amountOfSeizeTokenToSwap, // amountIn
            _flashLoanAmountToRepay, // amountOutMin
            swapPath, // path
            address(this), // to
            block.timestamp // deadline
        );

        // Check we received enough tokens to repay flash loan from the swap
        ERC20 flashLoanToken = ERC20(_flashLoanTokenAddress);
        require(
            flashLoanToken.balanceOf(address(this)) >= _flashLoanAmountToRepay,
            "JoeLiquidator: Expected to have enough tokens to repay flash loan after swapping seized tokens."
        );
    }

    /**
     * @notice The sender liquidates the borrowers collateral.
     * The collateral seized is transferred to the liquidator.
     * @param _borrowerToLiquidate The borrower of this jToken to be liquidated
     * @param _repayAmount The amount of the underlying borrowed asset to repay
     * @param _jSeizeToken The market in which to seize collateral from the borrower
     */
    function _liquidateBorrow(
        JErc20Interface _jRepayToken,
        address _borrowerToLiquidate,
        uint256 _repayAmount,
        JTokenInterface _jSeizeToken
    ) internal {
        // Now we should have `liquidationData.repayAmount` of underlying repay tokens
        // to liquidate the borrow position.
        bool isRepayNative = _jRepayToken.underlying() == WAVAX;

        uint256 repayTokenBalance = isRepayNative
            ? address(this).balance
            : ERC20(_jRepayToken.underlying()).balanceOf(address(this));
        require(
            repayTokenBalance == _repayAmount,
            "JoeLiquidator: Expected to have enough underlying repay token to liquidate borrow position."
        );
        console.log(
            "[JoeLiquidator] About to liquidateBorrow. Possess %d tokens of address:",
            repayTokenBalance
        );
        console.logAddress(_jRepayToken.underlying());

        uint256 err;
        if (isRepayNative) {
            err = JWrappedNativeInterface(_jRepayToken.underlying())
                .liquidateBorrowNative{value: _repayAmount}(
                _borrowerToLiquidate,
                _jSeizeToken
            );
        } else {
            // Approve repay jToken to take our underlying repay jToken so that we
            // can perform liquidation
            ERC20(_jRepayToken.underlying()).approve(
                address(_jRepayToken),
                _repayAmount
            );

            // Now, we can perform liquidation.
            err = _jRepayToken.liquidateBorrow(
                _borrowerToLiquidate,
                _repayAmount,
                _jSeizeToken
            );
        }
        if (err != 0) {
            console.log(
                "[JoeLiquidator][ERROR] Received error %d trying to liquidateBorrow...",
                err
            );
        }
        require(
            err == 0,
            "JoeLiquidator: Error occurred trying to liquidateBorrow"
        );
    }

    function _redeemSeizeToken(address _jSeizeTokenAddress) internal {
        // Get amount of jSeizeToken's we have
        uint256 amountOfJSeizeTokensToRedeem = JTokenInterface(
            _jSeizeTokenAddress
        ).balanceOf(address(this));

        // Redeem `amountOfJSeizeTokensToRedeem` jSeizeTokens for underlying seize tokens
        uint256 err = JErc20Interface(_jSeizeTokenAddress).redeem(
            amountOfJSeizeTokensToRedeem
        );
        require(
            err == 0,
            "JoeLiquidator: Error occurred trying to redeem underlying seize tokens"
        );
        console.log(
            "[JoeLiquidator] Successfully redeemed %d jSeizeTokens with address:",
            amountOfJSeizeTokensToRedeem
        );
        console.logAddress(_jSeizeTokenAddress);
    }

    function _swapFlashLoanTokenToRepayToken(
        address _flashLoanedTokenAddress,
        uint256 _flashLoanAmount,
        address _jRepayTokenUnderlyingAddress,
        uint256 _repayAmount
    ) internal {
        console.log(
            "[JoeLiquidator] Swapping flash loan token (posses %d) for repay token (need %d)...",
            _flashLoanAmount,
            _repayAmount
        );
        console.log(
            "[JoeLiquidator] Recalculating flash loan amount needed (%d)...",
            _getFlashLoanAmount(
                _jRepayTokenUnderlyingAddress,
                _repayAmount,
                false
            )
        );

        // Swap flashLoanedToken (e.g. USDC.e) to jBorrowTokenUnderlying (e.g. MIM)
        // Approve JoeRouter to transfer our flash loaned token so that we can swap for
        // the underlying repay token
        ERC20(_flashLoanedTokenAddress).approve(
            joeRouter02Address,
            _flashLoanAmount
        );

        address[] memory swapPath = new address[](2);
        swapPath[0] = _flashLoanedTokenAddress;
        swapPath[1] = _jRepayTokenUnderlyingAddress;

        // uint256[] memory amountsOutDebug = _getAmountsOut(
        //     _flashLoanAmount,
        //     swapPath
        // );
        // console.log(
        //     "[JoeLiquidator] Getting amounts out returns (%d, %d) with path:",
        //     amountsOutDebug[0],
        //     amountsOutDebug[1]
        // );
        // console.logAddress(_flashLoanedTokenAddress);
        // console.logAddress(_jRepayTokenUnderlyingAddress);

        bool isRepayNative = _jRepayTokenUnderlyingAddress == WAVAX;

        if (isRepayNative) {
            JoeRouter02(joeRouter02Address).swapExactTokensForAVAX(
                _flashLoanAmount, // amountIn
                _repayAmount, // amountOutMin
                swapPath, // path
                address(this), // to
                block.timestamp // deadline
            );
        } else {
            JoeRouter02(joeRouter02Address).swapExactTokensForTokens(
                _flashLoanAmount, // amountIn
                _repayAmount, // amountOutMin
                swapPath, // path
                address(this), // to
                block.timestamp // deadline
            );
        }
    }

    function _approveFlashLoanToken(
        address _flashLoanTokenAddress,
        uint256 _flashLoanAmountToRepay
    ) internal {
        ERC20 flashLoanToken = ERC20(_flashLoanTokenAddress);

        // Ensure we have enough to repay flash loan
        require(
            flashLoanToken.balanceOf(address(this)) >= _flashLoanAmountToRepay,
            "JoeLiquidator: Expected to have enough tokens to repay flash loan after swapping seized tokens."
        );

        // Approve flash loan lender to retrieve loan amount + fee from us
        flashLoanToken.approve(msg.sender, _flashLoanAmountToRepay);
    }

    function _getJTokenToFlashLoan(bool _isRepayTokenUSDCE)
        internal
        view
        returns (JCollateralCapErc20Delegator)
    {
        if (_isRepayTokenUSDCE) {
            console.log("[JoeLiquidator] Flash loaning from:");
            console.logAddress(jWETHEAddress);
            return JCollateralCapErc20Delegator(jWETHEAddress);
        } else {
            console.log("[JoeLiquidator] Flash loaning from:");
            console.logAddress(jUSDCEAddress);
            return JCollateralCapErc20Delegator(jUSDCEAddress);
        }
    }

    function _getFlashLoanAmount(
        address _underlyingRepayToken,
        uint256 _repayAmount,
        bool _isRepayTokenUSDCE
    ) internal view returns (uint256) {
        address[] memory path = new address[](2);
        if (_isRepayTokenUSDCE) {
            path[0] = WETHE;
        } else {
            path[0] = USDCE;
        }
        path[1] = _underlyingRepayToken;
        return
            JoeRouter02(joeRouter02Address).getAmountsIn(_repayAmount, path)[0];
    }

    function _getAmountsOut(uint256 _amountIn, address[] memory _path)
        internal
        view
        returns (uint256[] memory amounts)
    {
        return JoeRouter02(joeRouter02Address).getAmountsOut(_amountIn, _path);
    }

    function _getBalanceOfUnderlying(
        address _jSeizeTokenAddress,
        address _owner
    ) internal view returns (uint256) {
        JTokenInterface jSeizeToken = JTokenInterface(_jSeizeTokenAddress);

        // From https://github.com/traderjoe-xyz/joe-lending/blob/main/contracts/JToken.sol#L128
        Exp memory exchangeRate = Exp({
            mantissa: jSeizeToken.exchangeRateStored()
        });
        return mul_ScalarTruncate(exchangeRate, jSeizeToken.balanceOf(_owner));
    }
}

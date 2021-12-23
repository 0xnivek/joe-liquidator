// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

import "./interfaces/ERC20Interface.sol";
import "./interfaces/ERC3156FlashBorrowerInterface.sol";
import "./interfaces/ERC3156FlashLenderInterface.sol";
import "./interfaces/WAVAXInterface.sol";
import "./lending/JTokenInterfaces.sol";
import "./lending/JoeRouter02.sol";
import "./lending/JoetrollerInterface.sol";
import "./lending/PriceOracle.sol";
import "./libraries/SafeMath.sol";

contract JoeLiquidator is ERC3156FlashBorrowerInterface {
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
            liquidity != 0,
            "JoeLiquidator: Cannot liquidate account with non-zero liquidity"
        );
        _;
    }

    function liquidate(
        address _borrowerToLiquidate,
        address _jRepayTokenAddress,
        address _jSeizeTokenAddress
    ) external isLiquidatable(_borrowerToLiquidate) {
        uint256 amountToRepay = getAmountToRepay(
            _borrowerToLiquidate,
            _jRepayTokenAddress,
            _jSeizeTokenAddress
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

        uint256 closeFactor = joetroller.closeFactorMantissa();
        uint256 liquidationIncentive = joetroller
            .liquidationIncentiveMantissa();

        uint256 repayTokenUnderlyingPrice = priceOracle.getUnderlyingPrice(
            JToken(_jRepayTokenAddress)
        );
        uint256 seizeTokenUnderlyingPrice = priceOracle.getUnderlyingPrice(
            JToken(_jSeizeTokenAddress)
        );

        uint256 maxRepayAmount = (JTokenInterface(_jRepayTokenAddress)
            .borrowBalanceCurrent(_borrowerToLiquidate) * closeFactor) /
            uint256(10**18);
        uint256 maxSeizeAmount = (JTokenInterface(_jSeizeTokenAddress)
            .balanceOfUnderlying(_borrowerToLiquidate) * liquidationIncentive) /
            uint256(10**18);

        uint256 maxRepayAmountInUSD = maxRepayAmount *
            repayTokenUnderlyingPrice;
        uint256 maxSeizeAmountInUSD = maxSeizeAmount *
            seizeTokenUnderlyingPrice;

        uint256 maxAmountInUSD = (maxRepayAmountInUSD < maxSeizeAmountInUSD)
            ? maxRepayAmountInUSD
            : maxSeizeAmountInUSD;

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
        address underlyingRepayToken = JCollateralCapErc20Delegator(
            _jRepayTokenAddress
        ).underlying();
        bool isRepayTokenUSDCE = underlyingRepayToken == USDCE;

        uint256 flashLoanAmount = _getFlashLoanAmount(
            underlyingRepayToken,
            _repayAmount,
            isRepayTokenUSDCE
        );

        JCollateralCapErc20Delegator jTokenToFlashLoan = _getJTokenToFlashLoan(
            isRepayTokenUSDCE
        );

        bytes memory data = abi.encode(
            msg.sender, // initiator
            _borrowerToLiquidate, // borrowerToLiquidate
            jTokenToFlashLoan.underlying(), // flashLoanedTokenAddress
            _jRepayTokenAddress, // jRepayTokenAddress
            flashLoanAmount, // flashLoanAmount
            _repayAmount, // repayAmount
            _jSeizeTokenAddress // jSeizeTokenAddress
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

        LiquidationData memory liquidationData = _getLiquidationData(
            _initiator,
            _flashLoanTokenAddress,
            _flashLoanAmount,
            _data
        );

        // Approve flash loan lender to retrieve loan amount + fee from us
        ERC20 flashLoanToken = ERC20(_flashLoanTokenAddress);
        uint256 flashLoanAmountToRepay = _flashLoanAmount.add(_flashLoanFee);
        flashLoanToken.approve(msg.sender, flashLoanAmountToRepay);

        // ********************************************************************
        // Our custom logic begins here...
        // ********************************************************************

        JCollateralCapErc20Delegator jRepayToken = JCollateralCapErc20Delegator(
            liquidationData.jRepayTokenAddress
        );

        // Swap token that we flash loaned (e.g. USDC.e) to the underlying repay token
        _swapFlashLoanTokenToRepayToken(
            _flashLoanTokenAddress,
            _flashLoanAmount,
            jRepayToken.underlying(),
            liquidationData.repayAmount
        );

        // Now we should have `liquidationData.repayAmount` of underlying repay tokens
        // to liquidate the borrow position.
        require(
            ERC20(jRepayToken.underlying()).balanceOf(address(this)) ==
                liquidationData.repayAmount,
            "JoeLiquidator: Expected to have enough underlying repay token to liquidate borrow position."
        );

        // Perform liquidation using underlying repay token and receive seize token in return.
        _liquidateBorrow(
            jRepayToken,
            liquidationData.borrowerToLiquidate,
            liquidationData.repayAmount,
            JTokenInterface(liquidationData.jSeizeTokenAddress)
        );

        // Swap seize token to flash loan token to repay flashLoanAmountToRepay
        _swapSeizedTokenToFlashLoanToken(
            liquidationData.jSeizeTokenAddress,
            _flashLoanTokenAddress,
            flashLoanAmountToRepay
        );

        // Convert any remaining seized token to native AVAX
        _swapRemainingSeizedTokenToAVAX(
            _initiator,
            liquidationData.jSeizeTokenAddress
        );

        // // Transfer profited AVAX to liquidator
        // _transferProfitedAVAXToLiquidator(_initiator);

        // ********************************************************************
        // Our custom logic ends here...
        // ********************************************************************

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
            address flashLoanedTokenAddress,
            address jRepayTokenAddress,
            uint256 flashLoanAmount,
            uint256 repayAmount,
            address jSeizeTokenAddress
        ) = abi.decode(
                _data,
                (address, address, address, address, uint256, uint256, address)
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

    // function _transferProfitedAVAXToLiquidator(address _liquidator) internal {
    //     (bool success, ) = _liquidator.call{value: address(this).balance}("");
    //     require(
    //         success,
    //         "JoeLiquidator: Failed to transfer profited AVAX to liquidator"
    //     );
    // }

    function _swapRemainingSeizedTokenToAVAX(
        address _initiator,
        address _jSeizeTokenUnderlyingAddress
    ) internal {
        // Swap seized token to AVAX
        ERC20 seizeToken = ERC20(_jSeizeTokenUnderlyingAddress);
        uint256 remainingSeizeAmount = seizeToken.balanceOf(address(this));

        require(
            remainingSeizeAmount > 0,
            "JoeLiquidator: Expected to have remaining seize amount in order to have profited from liquidation"
        );

        seizeToken.approve(joeRouter02Address, remainingSeizeAmount);

        address[] memory swapPath = new address[](2);
        swapPath[0] = _jSeizeTokenUnderlyingAddress;
        swapPath[1] = WAVAX;
        JoeRouter02(joeRouter02Address).swapExactTokensForAVAX(
            remainingSeizeAmount, // amountIn
            0, // amountOutMin
            swapPath, // path
            _initiator, // to
            block.timestamp // deadline
        );
    }

    function _swapSeizedTokenToFlashLoanToken(
        address _jSeizeTokenUnderlyingAddress,
        address _flashLoanTokenAddress,
        uint256 _flashLoanAmountToRepay
    ) internal {
        // Swap seized token to flashLoanedToken (e.g. USDC.e)
        // TODO: Do we need to calculate the exact seizeAmount here?
        ERC20 seizeToken = ERC20(_jSeizeTokenUnderlyingAddress);
        uint256 seizeAmount = seizeToken.balanceOf(address(this));
        seizeToken.approve(joeRouter02Address, seizeAmount);

        address[] memory swapPath = new address[](2);
        swapPath[0] = _jSeizeTokenUnderlyingAddress;
        swapPath[1] = _flashLoanTokenAddress;
        JoeRouter02(joeRouter02Address).swapExactTokensForTokens(
            seizeAmount, // amountIn
            _flashLoanAmountToRepay, // amountOutMin
            swapPath, // path
            address(this), // to
            block.timestamp // deadline
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
        uint256 err = _jRepayToken.liquidateBorrow(
            _borrowerToLiquidate,
            _repayAmount,
            _jSeizeToken
        );
        require(
            err == 0,
            "JoeLiquidator: Error occurred trying to liquidateBorrow"
        );
    }

    function _swapFlashLoanTokenToRepayToken(
        address _flashLoanedTokenAddress,
        uint256 _flashLoanAmount,
        address _jRepayTokenUnderlyingAddress,
        uint256 _repayAmount
    ) internal {
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

        JoeRouter02(joeRouter02Address).swapExactTokensForTokens(
            _flashLoanAmount, // amountIn
            _repayAmount, // amountOutMin
            swapPath, // path
            address(this), // to
            block.timestamp // deadline
        );
    }

    function _getJTokenToFlashLoan(bool _isRepayTokenUSDCE)
        internal
        view
        returns (JCollateralCapErc20Delegator)
    {
        if (_isRepayTokenUSDCE) {
            return JCollateralCapErc20Delegator(jWETHEAddress);
        } else {
            return JCollateralCapErc20Delegator(jUSDCEAddress);
        }
    }

    function _getFlashLoanAmount(
        address _underlyingBorrowToken,
        uint256 _repayAmount,
        bool _isRepayTokenUSDCE
    ) internal view returns (uint256) {
        address[] memory path = new address[](2);
        if (_isRepayTokenUSDCE) {
            path[0] = WETHE;
        } else {
            path[0] = USDCE;
        }
        path[1] = _underlyingBorrowToken;
        return
            JoeRouter02(joeRouter02Address).getAmountsIn(_repayAmount, path)[0];
    }
}

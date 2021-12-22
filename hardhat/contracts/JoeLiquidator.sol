// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

import "./interfaces/ERC20Interface.sol";
import "./interfaces/ERC3156FlashBorrowerInterface.sol";
import "./interfaces/ERC3156FlashLenderInterface.sol";
import "./lending/JTokenInterfaces.sol";
import "./lending/JoeRouter02.sol";
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
        address flashLoanedTokenAddress;
        address jBorrowTokenAddress;
        address borrowerToLiquidate;
        address jSupplyTokenAddress;
        uint256 flashLoanAmount;
        uint256 borrowAmount;
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

    /**
     * @notice Perform flash loan for given jToken and amount
     * @param _jBorrowTokenAddress The address of the jToken contract to borrow from
     * @param _borrowAmount The amount of the tokens to borrow
     * @param _borrowerToLiquidate The address of the borrower to liquidate
     * @param _isBorrowTokenUSDC Indicates whether the borrow position to repay is in USDC
     * @param _jSupplyTokenAddress The address of the jToken contract to seize collateral from
     */
    function doFlashloan(
        address _jBorrowTokenAddress,
        uint256 _borrowAmount,
        address _borrowerToLiquidate,
        bool _isBorrowTokenUSDC,
        address _jSupplyTokenAddress
    ) external {
        address underlyingBorrowToken = JCollateralCapErc20Delegator(
            _jBorrowTokenAddress
        ).underlying();
        uint256 flashLoanAmount = _getFlashLoanAmount(
            underlyingBorrowToken,
            _borrowAmount,
            _isBorrowTokenUSDC
        );

        JCollateralCapErc20Delegator jTokenToFlashLoan = _getJTokenToFlashLoan(
            _isBorrowTokenUSDC
        );

        bytes memory data = abi.encode(
            msg.sender, // initiator
            _borrowerToLiquidate, // borrowerToLiquidate
            jTokenToFlashLoan.underlying(), // flashLoanedTokenAddress
            _jBorrowTokenAddress, // jBorrowTokenAddress
            flashLoanAmount, // flashLoanAmount
            _borrowAmount, // borrowAmount
            _jSupplyTokenAddress // jSupplyTokenAddress
        );

        jTokenToFlashLoan.flashLoan(this, msg.sender, flashLoanAmount, data);
    }

    /**
     * @notice Called by FlashLoanLender once flashloan is approved
     * @param _initiator The address that initiated this flash loan
     * @param _token The address of the underlying token contract borrowed from
     * @param _amount The amount of the tokens borrowed
     * @param _fee The fee for this flash loan
     * @param _data The encoded data used for this flash loan
     */
    function onFlashLoan(
        address _initiator,
        address _token,
        uint256 _amount,
        uint256 _fee,
        bytes calldata _data
    ) external override returns (bytes32) {
        require(
            Joetroller(joetrollerAddress).isMarketListed(msg.sender),
            "JoeLiquidator: Untrusted message sender"
        );

        // Use block scoping and structs to avoid stack too deep errors.
        // See https://soliditydeveloper.com/stacktoodeep to learn more.
        LiquidationData memory liquidationData;
        {
            (
                address initiator,
                address borrowerToLiquidate,
                address flashLoanedTokenAddress,
                address jBorrowTokenAddress,
                uint256 flashLoanAmount,
                uint256 borrowAmount,
                address jSupplyTokenAddress
            ) = abi.decode(
                    _data,
                    (
                        address,
                        address,
                        address,
                        address,
                        uint256,
                        uint256,
                        address
                    )
                );

            require(
                _initiator == initiator,
                "JoeLiquidator: Untrusted loan initiator"
            );
            require(
                _token == flashLoanedTokenAddress,
                "JoeLiquidator: Encoded data (flashLoanedTokenAddress) does not match"
            );
            require(
                _amount == flashLoanAmount,
                "JoeLiquidator: Encoded data (flashLoanAmount) does not match"
            );

            liquidationData.borrowerToLiquidate = borrowerToLiquidate;
            liquidationData.flashLoanedTokenAddress = flashLoanedTokenAddress;
            liquidationData.jBorrowTokenAddress = jBorrowTokenAddress;
            liquidationData.flashLoanAmount = flashLoanAmount;
            liquidationData.borrowAmount = borrowAmount;
            liquidationData.jSupplyTokenAddress = jSupplyTokenAddress;
        }

        // Approve flash loan lender to retrieve loan amount + fee from us
        ERC20 flashLoanedToken = ERC20(liquidationData.flashLoanedTokenAddress);
        flashLoanedToken.approve(msg.sender, _amount.add(_fee));

        // your logic is written here...
        JCollateralCapErc20Delegator jBorrowToken = JCollateralCapErc20Delegator(
                liquidationData.jBorrowTokenAddress
            );

        // Swap token that we flash loaned (e.g. USDC.e) to the token needed
        // to repay the borrow position (e.g. MIM)
        _swapFlashLoanTokenToBorrowToken(
            liquidationData.flashLoanedTokenAddress,
            liquidationData.flashLoanAmount,
            jBorrowToken.underlying(),
            liquidationData.borrowAmount
        );

        _performLiquidation(
            liquidationData.borrowerToLiquidate,
            liquidationData.borrowAmount,
            JTokenInterface(liquidationData.jSupplyTokenAddress)
        );

        return keccak256("ERC3156FlashBorrowerInterface.onFlashLoan");
    }

    /**
     * @notice The sender liquidates the borrowers collateral.
     * The collateral seized is transferred to the liquidator.
     * @param _borrowerToLiquidate The borrower of this jToken to be liquidated
     * @param _repayAmount The amount of the underlying borrowed asset to repay
     * @param _jTokenCollateral The market in which to seize collateral from the borrower
     */
    function _performLiquidation(
        address _borrowerToLiquidate,
        uint256 _repayAmount,
        JTokenInterface _jTokenCollateral
    ) internal {}

    function _swapFlashLoanTokenToBorrowToken(
        address _flashLoanedTokenAddress,
        uint256 _flashLoanAmount,
        address _jBorrowTokenUnderlyingAddress,
        uint256 _borrowAmount
    ) internal {
        // Swap flashLoanedToken (e.g. USDC.e) to jBorrowTokenUnderlying (e.g. MIM)
        ERC20(_flashLoanedTokenAddress).approve(
            joeRouter02Address,
            _flashLoanAmount
        );

        address[] memory swapPath = new address[](2);
        swapPath[0] = _flashLoanedTokenAddress;
        swapPath[1] = _jBorrowTokenUnderlyingAddress;

        JoeRouter02(joeRouter02Address).swapExactTokensForTokens(
            _flashLoanAmount, // amountIn
            _borrowAmount, // amountOutMin
            swapPath, // path
            _jBorrowTokenUnderlyingAddress, // to
            block.timestamp // deadline
        );
    }

    function _getJTokenToFlashLoan(bool _isBorrowTokenUSDC)
        internal
        view
        returns (JCollateralCapErc20Delegator)
    {
        if (_isBorrowTokenUSDC) {
            return JCollateralCapErc20Delegator(jWETHEAddress);
        } else {
            return JCollateralCapErc20Delegator(jUSDCEAddress);
        }
    }

    function _getFlashLoanAmount(
        address _underlyingBorrowToken,
        uint256 _borrowAmount,
        bool _isBorrowTokenUSDC
    ) internal view returns (uint256) {
        address[] memory path = new address[](2);
        if (_isBorrowTokenUSDC) {
            path[0] = WETHE;
        } else {
            path[0] = USDCE;
        }
        path[1] = _underlyingBorrowToken;
        return
            JoeRouter02(joeRouter02Address).getAmountsIn(_borrowAmount, path)[
                0
            ];
    }
}

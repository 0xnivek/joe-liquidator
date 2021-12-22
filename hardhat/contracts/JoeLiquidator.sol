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

    /**
     * @notice Perform flash loan for given jToken and amount
     * @param _jRepayTokenAddress The address of the jToken contract to borrow from
     * @param _repayAmount The amount of the tokens to repay
     * @param _borrowerToLiquidate The address of the borrower to liquidate
     * @param _isRepayTokenUSDC Indicates whether the borrow position to repay is in USDC
     * @param _jSeizeTokenAddress The address of the jToken contract to seize collateral from
     */
    function doFlashloan(
        address _jRepayTokenAddress,
        uint256 _repayAmount,
        address _borrowerToLiquidate,
        bool _isRepayTokenUSDC,
        address _jSeizeTokenAddress
    ) external {
        address underlyingRepayToken = JCollateralCapErc20Delegator(
            _jRepayTokenAddress
        ).underlying();
        uint256 flashLoanAmount = _getFlashLoanAmount(
            underlyingRepayToken,
            _repayAmount,
            _isRepayTokenUSDC
        );

        JCollateralCapErc20Delegator jTokenToFlashLoan = _getJTokenToFlashLoan(
            _isRepayTokenUSDC
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
     * @param _flashLoanToken The address of the underlying token contract borrowed from
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
                address jRepayTokenAddress,
                uint256 flashLoanAmount,
                uint256 repayAmount,
                address jSeizeTokenAddress
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
                _flashLoanTokenAddress == flashLoanedTokenAddress,
                "JoeLiquidator: Encoded data (flashLoanedTokenAddress) does not match"
            );
            require(
                _flashLoanAmount == flashLoanAmount,
                "JoeLiquidator: Encoded data (flashLoanAmount) does not match"
            );

            liquidationData.borrowerToLiquidate = borrowerToLiquidate;
            liquidationData.jRepayTokenAddress = jRepayTokenAddress;
            liquidationData.repayAmount = repayAmount;
            liquidationData.jSeizeTokenAddress = jSeizeTokenAddress;
        }

        // Approve flash loan lender to retrieve loan amount + fee from us
        ERC20 flashLoanedToken = ERC20(_flashLoanTokenAddress);
        flashLoanedToken.approve(
            msg.sender,
            _flashLoanAmount.add(_flashLoanFee)
        );

        // your logic is written here...
        JCollateralCapErc20Delegator jRepayToken = JCollateralCapErc20Delegator(
            liquidationData.jRepayTokenAddress
        );

        // Swap token that we flash loaned (e.g. USDC.e) to the token needed
        // to repay the borrow position (e.g. MIM)
        _swapFlashLoanTokenToBorrowToken(
            _flashLoanTokenAddress,
            _flashLoanAmount,
            jRepayToken.underlying(),
            liquidationData.repayAmount
        );

        _performLiquidation(
            jRepayToken,
            liquidationData.borrowerToLiquidate,
            liquidationData.repayAmount,
            JTokenInterface(liquidationData.jSeizeTokenAddress)
        );

        return keccak256("ERC3156FlashBorrowerInterface.onFlashLoan");
    }

    function _swapSeizedTokenToFlashLoanToken(
        address _jSeizeTokenUnderlyingAddress,
        uint256 _seizeAmount,
        address _flashLoanedTokenAddress,
        uint256 _flashLoanAmount
    ) internal {
        // // Swap seized token to flashLoanedToken (e.g. USDC.e)
        // ERC20(_flashLoanedTokenAddress).approve(
        //     joeRouter02Address,
        //     _flashLoanAmount
        // );
        // address[] memory swapPath = new address[](2);
        // swapPath[0] = _flashLoanedTokenAddress;
        // swapPath[1] = _jRepayTokenUnderlyingAddress;
        // JoeRouter02(joeRouter02Address).swapExactTokensForTokens(
        //     _flashLoanAmount, // amountIn
        //     _repayAmount, // amountOutMin
        //     swapPath, // path
        //     _jRepayTokenUnderlyingAddress, // to
        //     block.timestamp // deadline
        // );
    }

    /**
     * @notice The sender liquidates the borrowers collateral.
     * The collateral seized is transferred to the liquidator.
     * @param _borrowerToLiquidate The borrower of this jToken to be liquidated
     * @param _repayAmount The amount of the underlying borrowed asset to repay
     * @param _jSeizeToken The market in which to seize collateral from the borrower
     */
    function _performLiquidation(
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

    function _swapFlashLoanTokenToBorrowToken(
        address _flashLoanedTokenAddress,
        uint256 _flashLoanAmount,
        address _jRepayTokenUnderlyingAddress,
        uint256 _repayAmount
    ) internal {
        // Swap flashLoanedToken (e.g. USDC.e) to jBorrowTokenUnderlying (e.g. MIM)
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
            _jRepayTokenUnderlyingAddress, // to
            block.timestamp // deadline
        );
    }

    function _getJTokenToFlashLoan(bool _isRepayTokenUSDC)
        internal
        view
        returns (JCollateralCapErc20Delegator)
    {
        if (_isRepayTokenUSDC) {
            return JCollateralCapErc20Delegator(jWETHEAddress);
        } else {
            return JCollateralCapErc20Delegator(jUSDCEAddress);
        }
    }

    function _getFlashLoanAmount(
        address _underlyingBorrowToken,
        uint256 _repayAmount,
        bool _isRepayTokenUSDC
    ) internal view returns (uint256) {
        address[] memory path = new address[](2);
        if (_isRepayTokenUSDC) {
            path[0] = WETHE;
        } else {
            path[0] = USDCE;
        }
        path[1] = _underlyingBorrowToken;
        return
            JoeRouter02(joeRouter02Address).getAmountsIn(_repayAmount, path)[0];
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

// import "hardhat/console.sol";

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

/**
 * @notice Contract that performs liquidation of underwater accounts in the jToken markets
 */
contract JoeLiquidator is ERC3156FlashBorrowerInterface, Exponential {
    using SafeMath for uint256;

    /// @notice Addresses of Banker Joe contracts
    address public joetrollerAddress;
    address public joeRouter02Address;
    address public jUSDCAddress;
    address public jWETHAddress;

    /// @notice Addresses of ERC20 contracts
    address public constant WAVAX = 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7;
    address public constant WETH = 0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB;
    address public constant USDC = 0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664;

    struct LiquidationLocalVars {
        address jRepayTokenAddress;
        address jSeizeTokenAddress;
        address borrowerToLiquidate;
        uint256 repayAmount;
    }

    /// @notice Emitted upon successful liquidation
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
        address _jUSDCAddress,
        address _jWETHAddress
    ) {
        joetrollerAddress = _joetrollerAddress;
        joeRouter02Address = _joeRouter02Address;
        jUSDCAddress = _jUSDCAddress;
        jWETHAddress = _jWETHAddress;
    }

    /// @dev Need to implement receive function in order for this contract to receive AVAX.
    /// We need to receive AVAX when we liquidating a native borrow position.
    receive() external payable {}

    /**
     * @notice Ensure that we can liquidate the borrower
     * @dev A borrower is liquidatable if:
     *      1. Their `liquidity` is zero
     *      2. Their `shortfall` is non-zero
     */
    modifier isLiquidatable(address _borrowerToLiquidate) {
        (, uint256 liquidity, uint256 shortfall) = Joetroller(joetrollerAddress)
            .getAccountLiquidity(_borrowerToLiquidate);
        require(
            liquidity == 0,
            "JoeLiquidator: Cannot liquidate account with non-zero liquidity"
        );
        require(
            shortfall != 0,
            "JoeLiquidator: Cannot liquidate account with zero shortfall"
        );
        _;
    }

    /**
     * @notice Liquidates a borrower with a given jToken to repay and
     * jToken to seize.
     * @param _borrowerToLiquidate: Address of the borrower to liquidate
     * @param _jRepayTokenAddress: Address of the jToken to repay
     * @param _jSeizeTokenAddress: Address of the jToken to seize
     */
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

    /**
     * @dev Calculates amount of the borrow position to repay
     * @param _borrowerToLiquidate: Address of the borrower to liquidate
     * @param _jRepayTokenAddress: Address of the jToken to repay
     * @param _jSeizeTokenAddress: Address of the jToken to seize
     * @return the amount of jRepayToken to repay
     */
    function getAmountToRepay(
        address _borrowerToLiquidate,
        address _jRepayTokenAddress,
        address _jSeizeTokenAddress
    ) internal view returns (uint256) {
        // Inspired from https://github.com/haydenshively/Nantucket/blob/538bd999c9cc285efb403c876e5f4c3d467a2d68/contracts/FlashLiquidator.sol#L121-L144
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
            .borrowBalanceStored(_borrowerToLiquidate) * closeFactor) /
            uint256(10**18);
        uint256 maxSeizeAmount = (_getBalanceOfUnderlying(
            _jSeizeTokenAddress,
            _borrowerToLiquidate
        ) * uint256(10**18)) / liquidationIncentive;

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
     * @dev Gets an account's balanceOfUnderlying (i.e. supply balance) for a given jToken
     * @param _jTokenAddress The address of a jToken contract
     * @param _account The address the account to lookup
     * @return the account's balanceOfUnderlying in jToken
     */
    function _getBalanceOfUnderlying(address _jTokenAddress, address _account)
        internal
        view
        returns (uint256)
    {
        // From https://github.com/traderjoe-xyz/joe-lending/blob/main/contracts/JToken.sol#L128
        JTokenInterface jToken = JTokenInterface(_jTokenAddress);
        Exp memory exchangeRate = Exp({mantissa: jToken.exchangeRateStored()});
        return mul_ScalarTruncate(exchangeRate, jToken.balanceOf(_account));
    }

    /**
     * @notice Performs flash loan from:
     * - jWETH if _jRepayTokenAddress == jUSDC
     * - jUSDC otherwise
     * Upon receiving the flash loan, the tokens are swapped to the tokens needed
     * to repay the borrow position and perform liquidation.
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
        // See if the underlying repay token is USDC
        address underlyingRepayToken = JErc20Storage(_jRepayTokenAddress)
            .underlying();
        bool isRepayTokenUSDC = underlyingRepayToken == USDC;

        // Calculate the amount we need to flash loan
        uint256 flashLoanAmount = _getFlashLoanAmount(
            underlyingRepayToken,
            _repayAmount,
            isRepayTokenUSDC
        );

        // Calculate which jToken to flash loan from.
        // We will only ever flash loan from jUSDC or jWETH.
        JCollateralCapErc20Delegator jTokenToFlashLoan = _getJTokenToFlashLoan(
            isRepayTokenUSDC
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

        // Perform flash loan
        jTokenToFlashLoan.flashLoan(this, msg.sender, flashLoanAmount, data);
    }

    /**
     * @dev Calculates the amount needed to flash loan in order to repay
     * `_repayAmount` of the borrow position.
     * @param _underlyingRepayToken The token of the borrow position to repay
     * @param _repayAmount The amount of the borrow position to repay
     * @param _isRepayTokenUSDC Whether the token of the borrow position to repay is USDC
     * @return The flash loan amount required to repay the borrow position for liquidation.
     */
    function _getFlashLoanAmount(
        address _underlyingRepayToken,
        uint256 _repayAmount,
        bool _isRepayTokenUSDC
    ) internal view returns (uint256) {
        address[] memory path = new address[](2);

        // If the underlying repay token is USDC, we will flash loan from jWETH,
        // else we will flash loan jUSDC.
        if (_isRepayTokenUSDC) {
            path[0] = WETH;
        } else {
            path[0] = USDC;
        }
        path[1] = _underlyingRepayToken;
        return
            JoeRouter02(joeRouter02Address).getAmountsIn(_repayAmount, path)[0];
    }

    /**
     * @dev Gets the jToken to flash loan.
     * We always flash loan from jUSDC unless the repay token is USDC in which case we
     * flash loan from jWETH.
     * @param _isRepayTokenUSDC Whether the token of the borrow position to repay is USDC
     * @return The jToken to flash loan
     */
    function _getJTokenToFlashLoan(bool _isRepayTokenUSDC)
        internal
        view
        returns (JCollateralCapErc20Delegator)
    {
        if (_isRepayTokenUSDC) {
            return JCollateralCapErc20Delegator(jWETHAddress);
        } else {
            return JCollateralCapErc20Delegator(jUSDCAddress);
        }
    }

    /**
     * @dev Called by a jToken upon request of a flash loan
     * @param _initiator The address that initiated this flash loan
     * @param _flashLoanTokenAddress The address of the flash loan jToken's underlying asset
     * @param _flashLoanAmount The flash loan amount granted
     * @param _flashLoanFee The fee for this flash loan
     * @param _data The encoded data sent for this flash loan
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

        LiquidationLocalVars
            memory liquidationLocalVars = _getLiquidationLocalVars(
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
            liquidationLocalVars.jRepayTokenAddress
        );

        // Swap token that we flash loaned to the token we need to repay the borrow
        // position
        _swapFlashLoanTokenToRepayToken(
            _flashLoanTokenAddress,
            _flashLoanAmount,
            jRepayToken.underlying(),
            liquidationLocalVars.repayAmount
        );

        // Perform liquidation using the underlying repay token we swapped for and
        // receive jSeizeTokens in return.
        _liquidateBorrow(
            jRepayToken,
            liquidationLocalVars.borrowerToLiquidate,
            liquidationLocalVars.repayAmount,
            JTokenInterface(liquidationLocalVars.jSeizeTokenAddress)
        );

        // Redeem jSeizeTokens for underlying seize tokens
        _redeemSeizeToken(liquidationLocalVars.jSeizeTokenAddress);

        // Swap enough seize tokens to flash loan tokens so we can repay flash loan
        // amount + flash loan fee
        _swapSeizeTokenToFlashLoanToken(
            liquidationLocalVars.jSeizeTokenAddress,
            _flashLoanTokenAddress,
            flashLoanAmountToRepay
        );

        // Convert any remaining seized token to native AVAX, unless it already is
        // AVAX, and send to liquidator
        uint256 profitedAVAX = _swapRemainingSeizedTokenToAVAX(
            _initiator,
            liquidationLocalVars.jSeizeTokenAddress
        );

        require(
            profitedAVAX > 0,
            "JoeLiquidator: Expected to have profited from liquidation"
        );

        // ********************************************************************
        // Our custom logic ends here...
        // ********************************************************************

        // Approve flash loan lender to retrieve loan amount + fee from us
        _approveFlashLoanToken(_flashLoanTokenAddress, flashLoanAmountToRepay);

        // Emit event to indicate successful liquidation
        emit LiquidationEvent(
            liquidationLocalVars.borrowerToLiquidate,
            liquidationLocalVars.jRepayTokenAddress,
            liquidationLocalVars.jSeizeTokenAddress,
            liquidationLocalVars.repayAmount,
            profitedAVAX
        );

        return keccak256("ERC3156FlashBorrowerInterface.onFlashLoan");
    }

    /**
     * @dev Decodes the encoded `_data` and packs relevant data needed to perform
     * liquidation into a `LiquidationLocalVars` struct.
     * @param _initiator The address that initiated this flash loan
     * @param _flashLoanTokenAddress The address of the flash loan jToken's underlying asset
     * @param _flashLoanAmount The amount flash loaned
     * @param _data The encoded data sent for this flash loan
     * @return relevant decoded data needed to perform liquidation
     */
    function _getLiquidationLocalVars(
        address _initiator,
        address _flashLoanTokenAddress,
        uint256 _flashLoanAmount,
        bytes calldata _data
    ) internal pure returns (LiquidationLocalVars memory) {
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

        LiquidationLocalVars
            memory liquidationLocalVars = LiquidationLocalVars({
                borrowerToLiquidate: borrowerToLiquidate,
                jRepayTokenAddress: jRepayTokenAddress,
                jSeizeTokenAddress: jSeizeTokenAddress,
                repayAmount: repayAmount
            });
        return liquidationLocalVars;
    }

    /**
     * @dev Swaps the flash loan token to the token needed to repay the borrow position
     * @param _flashLoanedTokenAddress The address of the flash loan jToken's underlying asset
     * @param _flashLoanAmount The amount flash loaned
     * @param _jRepayTokenUnderlyingAddress The address of the jToken to repay's underlying asset
     * @param _repayAmount The amount of the borrow position to repay
     */
    function _swapFlashLoanTokenToRepayToken(
        address _flashLoanedTokenAddress,
        uint256 _flashLoanAmount,
        address _jRepayTokenUnderlyingAddress,
        uint256 _repayAmount
    ) internal {
        // Approve JoeRouter to transfer our flash loaned token so that we can swap for
        // the underlying repay token
        ERC20(_flashLoanedTokenAddress).approve(
            joeRouter02Address,
            _flashLoanAmount
        );

        address[] memory swapPath = new address[](2);
        swapPath[0] = _flashLoanedTokenAddress;
        swapPath[1] = _jRepayTokenUnderlyingAddress;

        bool isRepayNative = _jRepayTokenUnderlyingAddress == WAVAX;

        // Swap flashLoanedToken to jRepayTokenUnderlying
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

    /**
     * @dev Performs liquidation given:
     * - a borrower
     * - a borrow position to repay
     * - a supply position to seize
     * @param _jRepayToken The jToken to repay for liquidation
     * @param _borrowerToLiquidate The borrower to liquidate
     * @param _repayAmount The amount of _jRepayToken's underlying assset to repay
     * @param _jSeizeToken The jToken to seize collateral from
     */
    function _liquidateBorrow(
        JErc20Interface _jRepayToken,
        address _borrowerToLiquidate,
        uint256 _repayAmount,
        JTokenInterface _jSeizeToken
    ) internal {
        bool isRepayNative = _jRepayToken.underlying() == WAVAX;

        // We should have at least `_repayAmount` of underlying repay tokens from
        // swapping the flash loan tokens.
        uint256 repayTokenBalance = isRepayNative
            ? address(this).balance
            : ERC20(_jRepayToken.underlying()).balanceOf(address(this));
        require(
            repayTokenBalance >= _repayAmount,
            "JoeLiquidator: Expected to have enough underlying repay token to liquidate borrow position."
        );

        uint256 err;
        if (isRepayNative) {
            // Perform liquidation and receive jAVAX in return
            err = JWrappedNativeInterface(address(_jRepayToken))
                .liquidateBorrowNative{value: _repayAmount}(
                _borrowerToLiquidate,
                _jSeizeToken
            );
        } else {
            // Approve repay jToken to take our underlying repay tokens so that we
            // can perform liquidation
            ERC20(_jRepayToken.underlying()).approve(
                address(_jRepayToken),
                _repayAmount
            );

            // Perform liquidation and receive jSeizeTokens in return
            err = _jRepayToken.liquidateBorrow(
                _borrowerToLiquidate,
                _repayAmount,
                _jSeizeToken
            );
        }
        require(
            err == 0,
            "JoeLiquidator: Error occurred trying to liquidateBorrow"
        );
    }

    /**
     * @dev Seizes collateral from a jToken market after having successfully performed
     * liquidation
     * @param _jSeizeTokenAddress The address of the jToken to seize collateral from
     */
    function _redeemSeizeToken(address _jSeizeTokenAddress) internal {
        // Get amount of jSeizeToken's we have
        uint256 amountOfJSeizeTokensToRedeem = JTokenInterface(
            _jSeizeTokenAddress
        ).balanceOf(address(this));

        JErc20Interface jSeizeToken = JErc20Interface(_jSeizeTokenAddress);

        bool isSeizeNative = jSeizeToken.underlying() == WAVAX;

        // Redeem `amountOfJSeizeTokensToRedeem` jSeizeTokens for underlying seize tokens
        uint256 err;
        if (isSeizeNative) {
            err = JWrappedNativeInterface(_jSeizeTokenAddress).redeemNative(
                amountOfJSeizeTokensToRedeem
            );
        } else {
            err = jSeizeToken.redeem(amountOfJSeizeTokensToRedeem);
        }

        require(
            err == 0,
            "JoeLiquidator: Error occurred trying to redeem underlying seize tokens"
        );
    }

    /**
     * @dev Swaps enough of the seized collateral to flash loan tokens in order
     * to repay the flash loan amount + flash loan fee
     * @param _jSeizeTokenAddress The address of the jToken to seize collateral from
     * @param _flashLoanTokenAddress The address of the flash loan jToken's underlying asset
     * @param _flashLoanAmountToRepay The flash loan amount + flash loan fee to repay
     */
    function _swapSeizeTokenToFlashLoanToken(
        address _jSeizeTokenAddress,
        address _flashLoanTokenAddress,
        uint256 _flashLoanAmountToRepay
    ) internal {
        JErc20Storage jSeizeToken = JErc20Storage(_jSeizeTokenAddress);
        address jSeizeTokenUnderlyingAddress = jSeizeToken.underlying();

        // Calculate amount of underlying seize token we need
        // to swap in order to pay back the flash loan amount + fee
        address[] memory swapPath = new address[](2);
        swapPath[0] = jSeizeTokenUnderlyingAddress;
        swapPath[1] = _flashLoanTokenAddress;

        uint256 amountOfSeizeTokenToSwap = JoeRouter02(joeRouter02Address)
            .getAmountsIn(_flashLoanAmountToRepay, swapPath)[0];

        bool isSeizeNative = jSeizeTokenUnderlyingAddress == WAVAX;

        // Perform the swap to flash loan tokens!
        if (isSeizeNative) {
            JoeRouter02(joeRouter02Address).swapExactAVAXForTokens{
                value: amountOfSeizeTokenToSwap
            }(
                _flashLoanAmountToRepay, // amountOutMin
                swapPath, // path
                address(this), // to
                block.timestamp // deadline
            );
        } else {
            // Approve router to transfer `amountOfSeizeTokenToSwap` underlying
            // seize tokens
            ERC20 seizeToken = ERC20(jSeizeTokenUnderlyingAddress);
            seizeToken.approve(joeRouter02Address, amountOfSeizeTokenToSwap);

            // Swap seized token to flash loan token
            JoeRouter02(joeRouter02Address).swapExactTokensForTokens(
                amountOfSeizeTokenToSwap, // amountIn
                _flashLoanAmountToRepay, // amountOutMin
                swapPath, // path
                address(this), // to
                block.timestamp // deadline
            );
        }

        // Check we received enough flash loan tokens from the swap to repay the flash loan
        ERC20 flashLoanToken = ERC20(_flashLoanTokenAddress);
        require(
            flashLoanToken.balanceOf(address(this)) >= _flashLoanAmountToRepay,
            "JoeLiquidator: Expected to have enough tokens to repay flash loan after swapping seized tokens."
        );
    }

    /**
     * @dev Swaps all remaining of the seized collateral to AVAX, unless
     * the seized collateral is already AVAX, and sends it to the initiator.
     * @param _initiator The initiator of the flash loan, aka the liquidator
     * @param _jSeizeTokenAddress The address of jToken collateral was seized from
     * @return The AVAX received as profit from performing the liquidation.
     */
    function _swapRemainingSeizedTokenToAVAX(
        address _initiator,
        address _jSeizeTokenAddress
    ) internal returns (uint256) {
        JErc20Storage jSeizeToken = JErc20Storage(_jSeizeTokenAddress);
        address jSeizeTokenUnderlyingAddress = jSeizeToken.underlying();

        bool isSeizeNative = jSeizeTokenUnderlyingAddress == WAVAX;
        if (isSeizeNative) {
            // The seized collateral was AVAX so we can do a simple transfer to the liquidator
            uint256 profitedAVAX = address(this).balance;

            (bool success, ) = _initiator.call{value: profitedAVAX}("");
            require(
                success,
                "JoeLiquidator: Failed to transfer native AVAX to liquidator"
            );

            return profitedAVAX;
        } else {
            // Swap seized token to AVAX
            ERC20 seizeToken = ERC20(jSeizeTokenUnderlyingAddress);
            uint256 remainingSeizeAmount = seizeToken.balanceOf(address(this));

            require(
                remainingSeizeAmount > 0,
                "JoeLiquidator: Expected to have remaining seize amount in order to have profited from liquidation"
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

            // Return profitted AVAX
            return amounts[1];
        }
    }

    /**
     * @notice Approves the flash loan jToken to retrieve the flash loan amount + fee.
     * @param _flashLoanTokenAddress The address of the flash loan jToken's underlying asset
     * @param _flashLoanAmountToRepay The flash loan amount to repay
     */
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
}

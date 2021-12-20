// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

import "./interfaces/ERC3156FlashBorrowerInterface.sol";
import "./interfaces/ERC3156FlashLenderInterface.sol";
import "./lending/JTokenInterfaces.sol";
import "./libraries/SafeMath.sol";

interface Joetroller {
    function isMarketListed(address jTokenAddress) external view returns (bool);
}

interface JTokenInterface {}

interface ERC20 {
    function approve(address spender, uint256 amount) external;
}

contract JoeLiquidator is ERC3156FlashBorrowerInterface {
    using SafeMath for uint256;

    /**
     * @notice Joetroller address
     */
    address public joetroller;

    constructor(address _joetroller) {
        joetroller = _joetroller;
    }

    /**
     * @notice Perform flash loan for given jToken and amount
     * @param _flashloanLender The address of the FlashloanLender contract
     * @param _jBorrowToken The address of the jToken contract to borrow from
     * @param _borrowAmount The amount of the tokens to borrow
     * @param _borrowerToLiquidate The address of the borrower to liquidate
     */
    function doFlashloan(
        address _flashloanLender,
        address _jBorrowToken,
        uint256 _borrowAmount,
        address _borrowerToLiquidate
    ) external {
        address underlyingToken = JCollateralCapErc20(_jBorrowToken)
            .underlying();
        bytes memory data = abi.encode(
            underlyingToken,
            _borrowAmount,
            _borrowerToLiquidate,
            _jBorrowToken
        );
        ERC3156FlashLenderInterface(_flashloanLender).flashLoan(
            this,
            underlyingToken,
            _borrowAmount,
            data
        );
    }

    /**
     * @notice Called by FlashLoanLender once flashloan is approved
     * @param _initiator The address that initiated this flash loan
     * @param _underlyingToken The address of the underlying token contract borrowed from
     * @param _amount The amount of the tokens borrowed
     * @param _fee The fee for this flash loan
     * @param _data The encoded data used for this flash loan
     */
    function onFlashLoan(
        address _initiator,
        address _underlyingToken,
        uint256 _amount,
        uint256 _fee,
        bytes calldata _data
    ) external override returns (bytes32) {
        require(
            Joetroller(joetroller).isMarketListed(msg.sender),
            "JoeLiquidator: Untrusted message sender"
        );
        require(
            _initiator == address(this),
            "JoeLiquidator: Untrusted loan initiator"
        );
        (
            address borrowToken,
            uint256 borrowAmount,
            address borrowerToLiquidate,
            address jBorrowToken
        ) = abi.decode(_data, (address, uint256, address, address));
        require(
            borrowToken == _underlyingToken,
            "JoeLiquidator: Encoded data (borrowToken) does not match"
        );
        require(
            borrowAmount == _amount,
            "JoeLiquidator: Encoded data (borrowAmount) does not match"
        );
        ERC20(_underlyingToken).approve(msg.sender, _amount.add(_fee));

        // your logic is written here...
        performLiquidation(
            borrowerToLiquidate,
            borrowAmount,
            JTokenInterface(jBorrowToken)
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
    function performLiquidation(
        address _borrowerToLiquidate,
        uint256 _repayAmount,
        JTokenInterface _jTokenCollateral
    ) internal {}
}

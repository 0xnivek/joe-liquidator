// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

import "./ERC3156FlashLenderInterface.sol";
import "./ERC3156FlashBorrowerInterface.sol";
import "./JWrappedNative.sol";

interface Comptroller {
    function isMarketListed(address cTokenAddress) external view returns (bool);
}

interface ERC20 {
    function approve(address spender, uint256 amount) external;
}

// FlashloanBorrower is a simple flashloan Borrower implementation for testing
contract JoeFlashloanBorrower is ERC3156FlashBorrowerInterface {
    /**
     * @notice C.R.E.A.M. comptroller address
     */
    address public comptroller;

    constructor(address _comptroller) {
        comptroller = _comptroller;
    }

    function doFlashloan(
        address _flashloanLender,
        address _jBorrowToken,
        uint256 _borrowAmount
    ) external {
        bytes memory data = abi.encode(_jBorrowToken, _borrowAmount);
        ERC3156FlashLenderInterface(_flashloanLender).flashLoan(
            this,
            JWrappedNative(_jBorrowToken).underlying(),
            _borrowAmount,
            data
        );
    }

    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        require(
            Comptroller(comptroller).isMarketListed(msg.sender),
            "untrusted message sender"
        );
        require(
            initiator == address(this),
            "FlashBorrower: Untrusted loan initiator"
        );
        (address borrowToken, uint256 borrowAmount) = abi.decode(
            data,
            (address, uint256)
        );
        require(
            borrowToken == token,
            "encoded data (borrowToken) does not match"
        );
        require(
            borrowAmount == amount,
            "encoded data (borrowAmount) does not match"
        );
        ERC20(token).approve(msg.sender, amount + fee);
        // your logic is written here...
        return keccak256("ERC3156FlashBorrowerInterface.onFlashLoan");
    }
}

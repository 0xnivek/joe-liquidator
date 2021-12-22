// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

import "../interfaces/ERC3156FlashBorrowerInterface.sol";

interface JTokenInterface {}

interface Joetroller {
    function isMarketListed(address jTokenAddress) external view returns (bool);
}

interface JErc20Storage {
    function underlying() external returns (address);
}

interface JErc20Interface is JErc20Storage {
    function liquidateBorrow(
        address borrower,
        uint256 repayAmount,
        JTokenInterface jTokenCollateral
    ) external returns (uint256);
}

interface JWrappedNativeInterface is JErc20Interface {
    function liquidateBorrowNative(
        address borrower,
        JTokenInterface jTokenCollateral
    ) external payable returns (uint256);
}

interface JCollateralCapErc20Delegator is JErc20Interface {
    function flashLoan(
        ERC3156FlashBorrowerInterface receiver,
        address initiator,
        uint256 amount,
        bytes calldata data
    ) external returns (bool);
}

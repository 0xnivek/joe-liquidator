// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

import "../interfaces/ERC3156FlashBorrowerInterface.sol";

interface JTokenStorage {
    function totalBorrows() external view returns (uint256);

    /**
     * @notice Block timestamp that interest was last accrued at
     */
    function accrualBlockTimestamp() external view returns (uint256);
}

interface JTokenInterface is JTokenStorage {
    function balanceOf(address owner) external view returns (uint256);

    function balanceOfUnderlying(address owner) external view returns (uint256);

    function borrowRatePerSecond() external view returns (uint256);

    function supplyRatePerSecond() external view returns (uint256);

    function borrowBalanceCurrent(address account)
        external
        view
        returns (uint256);

    function borrowBalanceStored(address account)
        external
        view
        returns (uint256);

    function accrueInterest() external returns (uint256);

    function exchangeRateStored() external view returns (uint256);
}

interface JToken is JTokenInterface {}

interface JErc20Storage {
    function underlying() external returns (address);
}

interface JErc20Interface is JErc20Storage {
    function liquidateBorrow(
        address borrower,
        uint256 repayAmount,
        JTokenInterface jTokenCollateral
    ) external returns (uint256);

    function redeem(uint256 redeemTokens) external returns (uint256);

    function mint(uint256 mintAmount) external returns (uint256);

    function borrow(uint256 borrowAmount) external returns (uint256);
}

interface JWrappedNativeInterface is JErc20Interface {
    function flashLoan(
        ERC3156FlashBorrowerInterface receiver,
        address initiator,
        uint256 amount,
        bytes calldata data
    ) external returns (bool);

    function liquidateBorrowNative(
        address borrower,
        JTokenInterface jTokenCollateral
    ) external payable returns (uint256);

    function redeemNative(uint256 redeemTokens) external returns (uint256);

    function mintNative() external payable returns (uint256);

    function borrowNative(uint256 borrowAmount) external returns (uint256);
}

interface JWrappedNativeDelegator is JTokenInterface, JWrappedNativeInterface {}

interface JCollateralCapErc20Interface is JErc20Interface {
    function flashLoan(
        ERC3156FlashBorrowerInterface receiver,
        address initiator,
        uint256 amount,
        bytes calldata data
    ) external returns (bool);
}

interface JCollateralCapErc20Delegator is
    JTokenInterface,
    JCollateralCapErc20Interface
{}

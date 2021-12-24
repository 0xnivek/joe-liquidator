// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

import "./JTokenInterfaces.sol";
import "./PriceOracle.sol";

interface JoetrollerV1Storage {
    /**
     * @notice Oracle which gives the price of any given asset
     */
    function oracle() external view returns (PriceOracle);

    /**
     * @notice Multiplier used to calculate the maximum repayAmount when liquidating a borrow
     */
    function closeFactorMantissa() external view returns (uint256);

    /**
     * @notice Multiplier representing the discount on collateral that a liquidator receives
     */
    function liquidationIncentiveMantissa() external view returns (uint256);
}

interface Joetroller is JoetrollerV1Storage {
    function enterMarkets(address[] calldata jTokens)
        external
        returns (uint256[] memory);

    function isMarketListed(address jTokenAddress) external view returns (bool);

    function checkMembership(address account, JToken jToken)
        external
        view
        returns (bool);

    function getAccountLiquidity(address account)
        external
        view
        returns (
            uint256,
            uint256,
            uint256
        );

    function liquidateBorrowAllowed(
        address jTokenBorrowed,
        address jTokenCollateral,
        address liquidator,
        address borrower,
        uint256 repayAmount
    ) external returns (uint256);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

contract JErc20Storage {
    /**
     * @notice Underlying asset for this JToken
     */
    address public underlying;
}

contract JWrappedNative is JErc20Storage {}

contract JCollateralCapErc20 is JErc20Storage {}

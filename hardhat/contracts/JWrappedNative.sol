// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

contract JErc20Storage {
    /**
     * @notice Underlying asset for this JToken
     */
    address public underlying;
}

contract JErc20Interface is JErc20Storage {}

contract JWrappedNativeInterface is JErc20Interface {}

contract JWrappedNative is JWrappedNativeInterface {}

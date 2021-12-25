// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

import "./JTokenInterfaces.sol";

interface PriceOracle {
    /**
     * @notice Get the underlying price of a jToken asset
     * @param jToken The jToken to get the underlying price of
     * @return The underlying asset price mantissa (scaled by 1e18).
     *  Zero means the price is unavailable.
     */
    function getUnderlyingPrice(JToken jToken) external view returns (uint256);
}

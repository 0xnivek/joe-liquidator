// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

import "./JTokenInterfaces.sol";

interface Joetroller {
    function enterMarkets(address[] calldata jTokens)
        external
        returns (uint256[] memory);

    function isMarketListed(address jTokenAddress) external view returns (bool);
}

interface JoetrollerInterfaceExtension {
    function checkMembership(address account, JToken jToken)
        external
        view
        returns (bool);
}

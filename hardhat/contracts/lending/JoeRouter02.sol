// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

interface JoeRouter02 {
    function getAmountsIn(uint256 amountOut, address[] memory path)
        external
        view
        returns (uint256[] memory amounts);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

interface WAVAXInterface {
    function deposit() external payable;

    function transfer(address to, uint256 value) external returns (bool);

    function withdraw(uint256) external;

    function balanceOf(address account) external view returns (uint256);
}

// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;
interface IL2Pool {
    function deposit(uint256 value, uint256 commitmentHash) external payable;
}
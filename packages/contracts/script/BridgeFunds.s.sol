// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {IInbox} from "interfaces/external/IArbitrumBridge.sol";
import {IL1StandardBridge} from "interfaces/external/IOptimismAdapter.sol";

/**
 * @notice Bridge native ETH from Ethereum L1 to a supported OP Stack L2.
 * The recipient is the L2 relayer account that needs native ETH for gas.
 * @dev The funding account is `BRIDGE_SENDER_ADDRESS`, falling back to `DEPLOYER_ADDRESS`. When each
 *      destination relayer holds its own L1 float, it funds itself: sender and recipient are equal.
 */
contract BridgeFundsToOpStack is Script {
    function run() external {
        string memory _target = vm.envString("L2_TARGET");
        address _bridge = vm.envAddress(string.concat(_target, "_L1_STANDARD_BRIDGE_ADDRESS"));
        address _recipient = vm.envAddress(string.concat(_target, "_RELAYER_ADDRESS"));
        uint32 _gasLimit = uint32(vm.envUint(string.concat(_target, "_BRIDGE_GAS_LIMIT")));
        uint256 _amount = vm.envUint("BRIDGE_AMOUNT_WEI");
        address _sender = vm.envOr("BRIDGE_SENDER_ADDRESS", vm.envAddress("DEPLOYER_ADDRESS"));

        if (_amount == 0) revert("BRIDGE_AMOUNT_WEI must be non-zero");
        if (_recipient == address(0)) revert("L2 relayer recipient must be non-zero");

        vm.startBroadcast(_sender);
        IL1StandardBridge(_bridge).bridgeETHTo{value: _amount}(_recipient, _gasLimit, "");
        vm.stopBroadcast();

        console.log("Bridged native ETH to L2 target:", _target);
        console.log("L1 bridge:", _bridge);
        console.log("L2 recipient:", _recipient);
        console.log("Amount:", _amount);
        console.log("Minimum L2 gas limit:", _gasLimit);
    }
}

/**
 * @notice Bridge native ETH from Ethereum L1 to Arbitrum.
 * @dev Arbitrum is not OP Stack and has no standard bridge for native ETH: the deposit is a
 *      retryable ticket on the Delayed Inbox. `depositEth` credits `msg.sender` on L2, so unlike the
 *      OP Stack path there is no recipient argument -- the funding key *is* the destination account.
 *      `{TARGET}_RELAYER_ADDRESS` is therefore read only to assert the broadcasting key is the one
 *      the funds are meant for; a mismatch would silently fund the wrong L2 account.
 */
contract BridgeFundsToArbitrum is Script {
    function run() external {
        string memory _target = vm.envString("L2_TARGET");
        address _inbox = vm.envAddress(string.concat(_target, "_L1_INBOX_ADDRESS"));
        address _recipient = vm.envAddress(string.concat(_target, "_RELAYER_ADDRESS"));
        uint256 _amount = vm.envUint("BRIDGE_AMOUNT_WEI");
        address _sender = vm.envOr("BRIDGE_SENDER_ADDRESS", vm.envAddress("DEPLOYER_ADDRESS"));

        if (_amount == 0) revert("BRIDGE_AMOUNT_WEI must be non-zero");
        if (_recipient == address(0)) revert("L2 relayer recipient must be non-zero");
        if (_sender != _recipient) revert("depositEth credits msg.sender: sender must equal recipient");

        vm.startBroadcast(_sender);
        IInbox(_inbox).depositEth{value: _amount}();
        vm.stopBroadcast();

        console.log("Bridged native ETH to L2 target:", _target);
        console.log("L1 delayed inbox:", _inbox);
        console.log("L2 recipient (== sender):", _recipient);
        console.log("Amount:", _amount);
    }
}

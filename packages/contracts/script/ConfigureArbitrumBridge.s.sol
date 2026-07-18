// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {console} from 'forge-std/console.sol';

import {Constants} from 'contracts/lib/Constants.sol';
import {Entrypoint} from 'contracts/Entrypoint.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';

/**
 * @notice Configure an Arbitrum L1->L2 bridge for a deployed L1 pool.
 *
 * Arbitrum delivers L1->L2 messages as retryable tickets that prepay their L2 execution up front, so
 * this sets the note-message and (for ERC20) token-bridge gas/fee terms in addition to the L1
 * endpoints. The endpoints are environment-driven; never hard-code Inbox / Gateway Router addresses
 * in an application script. Run this with the Entrypoint owner account after both pools are deployed.
 *
 * Field mapping (per IEntrypoint.BridgeConfig):
 * - l1Messenger        = Arbitrum Delayed Inbox
 * - l1TokenBridge      = Arbitrum L1 Gateway Router
 * - messageGasLimit    = retryable gasLimit for the note message
 * - messageMaxFeePerGas= retryable maxFeePerGas for the note message
 * - messageFee         = maxSubmissionCost for the note message
 * - tokenGasLimit      = gateway maxGas (ERC20 only)
 * - tokenMaxFeePerGas  = gateway gasPriceBid (ERC20 only)
 * - tokenFee           = gateway maxSubmissionCost (ERC20 only)
 *
 * NOTE: these fee terms must comfortably cover live L1 basefee / L2 gas conditions, or a retryable
 * will fail to auto-redeem. Pad them; the pool refunds any unused prepaid `msg.value` to the relayer.
 *
 * Required environment:
 * - DEPLOYER_ADDRESS, ENTRYPOINT_ADDRESS
 * - L2_TARGET (for example, ARB_SEPOLIA)
 * - <L2_TARGET>_CHAIN_ID
 * - <L2_TARGET>_L1_INBOX_ADDRESS
 * - <L2_TARGET>_L1_GATEWAY_ROUTER_ADDRESS
 * - <L2_TARGET>_L2_POOL_ADDRESS
 * - <L2_TARGET>_MESSAGE_GAS_LIMIT, <L2_TARGET>_MESSAGE_MAX_FEE_PER_GAS, <L2_TARGET>_MESSAGE_SUBMISSION_COST
 *
 * Optional environment (ERC20 destinations; default to native, all token terms zero):
 * - <L2_TARGET>_L2_ASSET_ADDRESS (L1 token; defaults to the native sentinel)
 * - <L2_TARGET>_L2_TOKEN_ADDRESS (remote L2 token)
 * - <L2_TARGET>_TOKEN_GAS_LIMIT, <L2_TARGET>_TOKEN_MAX_FEE_PER_GAS, <L2_TARGET>_TOKEN_SUBMISSION_COST
 */
contract ConfigureArbitrumBridge is Script {
  function run() external {
    string memory _target = vm.envString('L2_TARGET');
    address _asset = vm.envOr(string.concat(_target, '_L2_ASSET_ADDRESS'), Constants.NATIVE_ASSET);

    // Env reads are inlined into the struct to keep the local-variable count low (this script
    // compiles under the non-via-IR default profile).
    vm.startBroadcast(vm.envAddress('DEPLOYER_ADDRESS'));
    Entrypoint(payable(vm.envAddress('ENTRYPOINT_ADDRESS'))).setBridgeConfig(
      vm.envUint(string.concat(_target, '_CHAIN_ID')),
      _asset,
      IEntrypoint.BridgeConfig({
        kind: IEntrypoint.BridgeKind.Arbitrum,
        isSupported: true,
        l1Messenger: vm.envAddress(string.concat(_target, '_L1_INBOX_ADDRESS')),
        l1TokenBridge: vm.envAddress(string.concat(_target, '_L1_GATEWAY_ROUTER_ADDRESS')),
        l2Pool: vm.envAddress(string.concat(_target, '_L2_POOL_ADDRESS')),
        l2PoolFelt: 0,
        l2Handler: 0,
        // Remote L2 token (ERC20 destinations only; zero for native)
        l2Token: vm.envOr(string.concat(_target, '_L2_TOKEN_ADDRESS'), address(0)),
        // Note-message retryable terms (required for both native and ERC20)
        messageGasLimit: vm.envUint(string.concat(_target, '_MESSAGE_GAS_LIMIT')),
        messageMaxFeePerGas: vm.envUint(string.concat(_target, '_MESSAGE_MAX_FEE_PER_GAS')),
        messageFee: vm.envUint(string.concat(_target, '_MESSAGE_SUBMISSION_COST')),
        // Token-bridge terms (ERC20 destinations only; zero for native)
        tokenGasLimit: vm.envOr(string.concat(_target, '_TOKEN_GAS_LIMIT'), uint256(0)),
        tokenMaxFeePerGas: vm.envOr(string.concat(_target, '_TOKEN_MAX_FEE_PER_GAS'), uint256(0)),
        tokenFee: vm.envOr(string.concat(_target, '_TOKEN_SUBMISSION_COST'), uint256(0))
      })
    );
    vm.stopBroadcast();

    console.log('Configured Arbitrum bridge for chain:', vm.envUint(string.concat(_target, '_CHAIN_ID')));
    console.log('Asset:', _asset);
  }
}

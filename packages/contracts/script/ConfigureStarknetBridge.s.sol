// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {console} from 'forge-std/console.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';

/**
 * @notice Configure StarkGate `depositWithMessage` for a deployed L1 pool.
 *
 * This is the Starknet twin of {ConfigureOpStackBridge}. Without it the pool's `_bridgeStarknet`
 * path is never reachable: `_bridge` reads `getBridgeConfig(chainId, ASSET)` and reverts
 * `UnsupportedChain` until this config is written. Run it with the Entrypoint owner account
 * (deployer == owner in the standard setup) AFTER the L1 pool and the Cairo pool both exist.
 *
 * The StarkGate address, destination felt and fee are environment-driven. A single
 * `depositWithMessage` credits tokens before invoking the Cairo pool's `on_receive` callback.
 *
 * Required environment (prefixed by L2_TARGET, e.g. STARKNET_SEPOLIA):
 * - DEPLOYER_ADDRESS, ENTRYPOINT_ADDRESS
 * - L2_TARGET (for example, STARKNET_SEPOLIA)
 * - <L2_TARGET>_CHAIN_ID                    destination chain id used as `withdrawal.chainId`
 *                                           (Starknet Sepolia: 393402133025997798000961)
 * - <L2_TARGET>_L1_STARKGATE_ADDRESS        StarkGate ETH bridge on L1
 * - <L2_TARGET>_L2_POOL_FELT                Cairo pool address as a felt252 (decimal or 0x)
 * - <L2_TARGET>_TOKEN_FEE_WEI               prepaid ETH fee for StarkGate `depositWithMessage`
 *
 * Optional environment:
 * - <L2_TARGET>_L1_TOKEN_ADDRESS            L1 ERC20 to bridge (omit for native ETH; default native)
 */
contract ConfigureStarknetBridge is Script {
  function run() external {
    address _deployer = vm.envAddress('DEPLOYER_ADDRESS');
    Entrypoint _entrypoint = Entrypoint(payable(vm.envAddress('ENTRYPOINT_ADDRESS')));
    string memory _target = vm.envString('L2_TARGET');

    uint256 _destinationChainId = vm.envUint(string.concat(_target, '_CHAIN_ID'));
    address _starkgate = vm.envAddress(string.concat(_target, '_L1_STARKGATE_ADDRESS'));
    uint256 _l2PoolFelt = vm.envUint(string.concat(_target, '_L2_POOL_FELT'));
    uint256 _tokenFee = vm.envUint(string.concat(_target, '_TOKEN_FEE_WEI'));

    // The bridge config is keyed by the pool's asset. Native pools key on the sentinel; an ERC20
    // pool keys on its own L1 token address (which is also the token StarkGate locks).
    address _token = vm.envOr(string.concat(_target, '_L1_TOKEN_ADDRESS'), Constants.NATIVE_ASSET);

    vm.startBroadcast(_deployer);
    _entrypoint.setBridgeConfig(
      _destinationChainId,
      _token,
      IEntrypoint.BridgeConfig({
        kind: IEntrypoint.BridgeKind.Starknet,
        isSupported: true,
        // No separate Starknet Core note message: the commitment rides with StarkGate.
        l1Messenger: address(0),
        l1TokenBridge: _starkgate,
        // EVM pool address is unused for Starknet; the destination is carried as a felt.
        l2Pool: address(0),
        l2PoolFelt: _l2PoolFelt,
        l2Handler: 0,
        l2Token: address(0),
        // Starknet does not use the EVM bridge gas fields here; StarkGate takes one flat fee.
        messageGasLimit: 0,
        messageMaxFeePerGas: 0,
        messageFee: 0,
        tokenGasLimit: 0,
        tokenMaxFeePerGas: 0,
        tokenFee: _tokenFee
      })
    );
    vm.stopBroadcast();

    console.log('Configured Starknet bridge for destination chain:', _destinationChainId);
    console.log('L2 pool (felt):', _l2PoolFelt);
    console.log('StarkGate bridge:', _starkgate);
  }
}

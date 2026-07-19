// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {console} from 'forge-std/console.sol';

import {PrivacyPool} from 'contracts/PrivacyPool.sol';

/**
 * @notice Redeploy the L1 PrivacyPool carrying the StarkGate `depositWithMessage` flow.
 *
 * The pool is not upgradeable, so changing `_bridgeStarknet` to atomically bridge backing and
 * deliver the commitment requires a fresh deployment.
 *
 * Required env: DEPLOYER_ADDRESS, ENTRYPOINT_ADDRESS, WITHDRAWAL_VERIFIER, RAGEQUIT_VERIFIER, ASSET
 */
contract DeployStarknetPool is Script {
  function run() external returns (address _pool) {
    address _deployer = vm.envAddress('DEPLOYER_ADDRESS');
    address _entrypoint = vm.envAddress('ENTRYPOINT_ADDRESS');
    address _withdrawalVerifier = vm.envAddress('WITHDRAWAL_VERIFIER');
    address _ragequitVerifier = vm.envAddress('RAGEQUIT_VERIFIER');
    address _asset = vm.envAddress('ASSET');

    vm.startBroadcast(_deployer);
    PrivacyPool _p = new PrivacyPool(_entrypoint, _withdrawalVerifier, _ragequitVerifier, _asset);
    vm.stopBroadcast();

    _pool = address(_p);
    console.log('PrivacyPool (StarkGate message flow):', _pool);
    console.log('SCOPE:', _p.SCOPE());
  }
}

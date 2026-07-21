// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from 'forge-std/Script.sol';
import {VmSafe} from 'forge-std/Vm.sol';
import {console} from 'forge-std/console.sol';

import {L2PrivacyPoolArbitrum} from 'contracts/L2/L2PrivacyPoolArbitrum.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {L2WithdrawalVerifier} from 'contracts/verifiers/L2WithdrawalVerifier.sol';

/**
 * @notice Deploy the destination-side Mode-3 pool on an Arbitrum L2.
 *
 * Unlike the OP-Stack deploy, Arbitrum has no L2 cross-domain messenger: an inbound note arrives as
 * a retryable ticket whose L2 `msg.sender` is the L1 pool's aliased address. `L2PrivacyPoolArbitrum`
 * authenticates by undoing that alias, so no messenger address is configured here.
 *
 * Required environment:
 * - DEPLOYER_ADDRESS
 * - L1_POOL_ADDRESS
 * - L2_TARGET (for example, ARB_SEPOLIA)
 *
 * Optional environment:
 * - <L2_TARGET>_L2_ASSET_ADDRESS (defaults to the native asset sentinel)
 * - <L2_TARGET>_MAX_RELAY_FEE_BPS (defaults to 100)
 */
contract DeployL2Arbitrum is Script {
  function run() external returns (address _pool, address _verifier) {
    address _deployer = vm.envAddress('DEPLOYER_ADDRESS');
    address _l1Pool = vm.envAddress('L1_POOL_ADDRESS');
    string memory _target = vm.envString('L2_TARGET');
    address _asset = vm.envOr(string.concat(_target, '_L2_ASSET_ADDRESS'), Constants.NATIVE_ASSET);
    uint256 _maxRelayFeeBPS = vm.envOr(string.concat(_target, '_MAX_RELAY_FEE_BPS'), uint256(100));

    require(_deployer != address(0) && _l1Pool != address(0), 'missing deployment address');

    vm.startBroadcast(_deployer);
    L2WithdrawalVerifier _withdrawalVerifier = new L2WithdrawalVerifier();
    L2PrivacyPoolArbitrum _l2Pool =
      new L2PrivacyPoolArbitrum(_asset, _l1Pool, address(_withdrawalVerifier), _maxRelayFeeBPS);
    vm.stopBroadcast();

    _verifier = address(_withdrawalVerifier);
    _pool = address(_l2Pool);

    if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
      _saveDeploymentData(_pool, _verifier, _asset, _l1Pool);
    }

    console.log('L2WithdrawalVerifier:', _verifier);
    console.log('L2PrivacyPoolArbitrum:', _pool);
    console.log('L2 chain id:', block.chainid);
  }

  function _saveDeploymentData(address _pool, address _verifier, address _asset, address _l1Pool) internal {
    // The app feeds this to eth_getLogs, which pages in the L2 block-number domain. Getting the
    // domain wrong is silent: an L1 number (~11.3M) is a valid-looking block on a chain that is at
    // ~290M, so indexing just starts 278M blocks early and finds nothing.
    //
    // Neither in-script source gives that number. The ArbSys precompile is a node feature and the
    // script body runs in forge's own EVM, which aborts on it with InvalidFEOpcode. And forge fills
    // `block.number` from the parent-chain block here, not the L2 one -- that is where an L1 number
    // would come from. So the caller passes it in, read from the L2 endpoint; see the yarn alias.
    uint256 _deploymentBlock = vm.envUint(string.concat(vm.envString('L2_TARGET'), '_L2_HEAD_BLOCK'));
    require(_deploymentBlock > 1e8, 'L2_HEAD_BLOCK looks like an L1 block number, not an Arbitrum L2 one');
    string memory _json = string.concat(
      '{"chainId":',
      vm.toString(block.chainid),
      ',"contracts":[',
      '{"name":"L2WithdrawalVerifier","address":"',
      vm.toString(_verifier),
      '","deployer":"',
      vm.toString(vm.envAddress('DEPLOYER_ADDRESS')),
      '","deploymentBlock":',
      vm.toString(_deploymentBlock),
      '},',
      '{"name":"L2PrivacyPoolArbitrum","address":"',
      vm.toString(_pool),
      '","deployer":"',
      vm.toString(vm.envAddress('DEPLOYER_ADDRESS')),
      '","deploymentBlock":',
      vm.toString(_deploymentBlock),
      ',"scope":',
      vm.toString(L2PrivacyPoolArbitrum(payable(_pool)).SCOPE()),
      ',"asset":"',
      vm.toString(_asset),
      '","l1Pool":"',
      vm.toString(_l1Pool),
      '"}]} '
    );
    vm.writeJson(_json, string.concat('deployments/', vm.toString(block.chainid), '.json'));
    console.log('L2 deployment data saved to deployments/%s.json', vm.toString(block.chainid));
  }
}

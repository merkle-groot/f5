// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {AddressAliasHelper} from '../lib/AddressAliasHelper.sol';
import {L2PrivacyPool} from './L2PrivacyPool.sol';

/**
 * @title L2PrivacyPoolArbitrum
 * @notice Destination-side shielded pool for an Arbitrum L2, delivered over Arbitrum retryable
 *         tickets instead of the OP-Stack cross-domain messenger.
 * @dev The pool body — state tree, backing invariant, activation, and withdrawals — is inherited
 *      from {L2PrivacyPool} unchanged. Only the cross-domain authentication differs: Arbitrum has no
 *      messenger, so an L1->L2 note arrives as a direct call whose `msg.sender` is the L1 pool's
 *      aliased address. `_authenticateNote` recovers the L1 sender and checks it against `L1_POOL`.
 *
 *      The base `deposit` is payable, so a native (ETH) Arbitrum delivery — which rides the bridged
 *      value as the retryable ticket's call value in the same message as the note — is credited as
 *      backing by the balance-based `tokensReceivedFromBridge`, activating the note in one ticket.
 */
contract L2PrivacyPoolArbitrum is L2PrivacyPool {
  /**
   * @notice Initialize the Arbitrum destination pool
   * @dev The messenger is unused for Arbitrum and passed as the zero address to the base.
   * @param _asset The pool asset (`Constants.NATIVE_ASSET` for native)
   * @param _l1Pool The L1 pool authorized to deliver notes
   * @param _withdrawalVerifier The Groth16 verifier for withdrawals
   * @param _maxRelayFeeBPS The maximum allowed relay fee in basis points
   */
  constructor(
    address _asset,
    address _l1Pool,
    address _withdrawalVerifier,
    uint256 _maxRelayFeeBPS
  ) L2PrivacyPool(_asset, _l1Pool, address(0), _withdrawalVerifier, _maxRelayFeeBPS) {}

  /**
   * @notice Authenticate an inbound note via Arbitrum address aliasing.
   * @dev The retryable ticket originates from the L1 pool, so the L2 `msg.sender` is
   *      `applyL1ToL2Alias(L1_POOL)`. Undo the alias and require it to equal `L1_POOL`.
   */
  function _authenticateNote() internal view override {
    if (AddressAliasHelper.undoL1ToL2Alias(msg.sender) != L1_POOL) revert NotL1Pool();
  }
}

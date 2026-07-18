// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {L2ProofLib} from '../contracts/lib/L2ProofLib.sol';

/**
 * @title IL2PrivacyPool
 * @notice Interface for the destination-side (L2) shielded pool.
 * @dev This pool is the delivery end of a Mode 3 withdrawal. It does not take public deposits, run
 *      an ASP check, or mint change notes. Its only inputs are the two canonical-bridge operations
 *      emitted by the L1 pool — a note message and a token transfer — which arrive in separate,
 *      unordered transactions. Its only user-facing action is a private withdrawal that spends a
 *      delivered note and exits its full value to a clear recipient.
 */
interface IL2PrivacyPool {
  /*///////////////////////////////////////////////////////////////
                              STRUCTS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice A withdrawal request, whose integrity is bound by the proof `context` signal
   * @param processooor The address permitted to submit this withdrawal (the relayer)
   * @param data Encoded `RelayData`
   */
  struct Withdrawal {
    address processooor;
    bytes data;
  }

  /**
   * @notice Relay data for an L2 withdrawal
   * @param recipient The clear recipient of the withdrawn funds
   * @param feeRecipient The recipient of the relay fee
   * @param relayFeeBPS The relay fee in basis points
   */
  struct RelayData {
    address recipient;
    address feeRecipient;
    uint256 relayFeeBPS;
  }

  /*///////////////////////////////////////////////////////////////
                              EVENTS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Emitted when a bridged note message is received from the L1 pool (still pending backing)
   * @param _commitment The delivered destination-note commitment (C_dest)
   * @param _value The note value carried in cleartext by the message
   */
  event NoteReceived(uint256 indexed _commitment, uint256 _value);

  /**
   * @notice Emitted when a pending note becomes spendable (its bridged tokens have landed) and is
   *         inserted into the L2 state tree
   * @param _commitment The activated destination-note commitment (C_dest)
   * @param _value The note value now backing spendable supply
   */
  event NoteActivated(uint256 indexed _commitment, uint256 _value);

  /**
   * @notice Emitted when a note is spent and its value exits to a clear recipient
   * @param _recipient The recipient of the withdrawn funds
   * @param _spentNullifier The spent nullifier
   * @param _value The withdrawn value (before the relay fee)
   * @param _feeAmount The relay fee paid
   */
  event Withdrawn(address indexed _recipient, uint256 _spentNullifier, uint256 _value, uint256 _feeAmount);

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  //////////////////////////////////////////////////////////////*/

  /// @notice Thrown when a note-intake call did not come from the configured L2 messenger
  error NotMessenger();

  /// @notice Thrown when the cross-domain message did not originate from the configured L1 pool
  error NotL1Pool();

  /// @notice Thrown when receiving a note whose commitment has already been delivered
  error NoteAlreadyReceived();

  /// @notice Thrown when trying to activate a note that is not (or no longer) pending
  error NoteNotPending();

  /// @notice Thrown when trying to activate a note whose bridged tokens have not fully landed yet
  error NoteNotBacked();

  /// @notice Thrown when the caller is not the request's designated processooor (relayer)
  error InvalidProcessooor();

  /// @notice Thrown when the proof context does not match the withdrawal request
  error ContextMismatch();

  /// @notice Thrown when the proof references an unknown or outdated state root
  error UnknownStateRoot();

  /// @notice Thrown when the proof's tree depth exceeds the maximum
  error InvalidTreeDepth();

  /// @notice Thrown when the withdrawn value is zero
  error InvalidWithdrawalAmount();

  /// @notice Thrown when the relay fee exceeds the configured maximum
  error RelayFeeGreaterThanMax();

  /// @notice Thrown when the Groth16 withdrawal proof fails verification
  error InvalidProof();

  /// @notice Thrown when trying to spend an already-spent nullifier
  error NullifierAlreadySpent();

  /// @notice Thrown when sending native asset fails
  error FailedToSendNativeAsset();

  /// @notice Thrown when a constructor address argument is zero
  error ZeroAddress();

  /*///////////////////////////////////////////////////////////////
                               LOGIC
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Receive a bridged note message from the L1 pool (the note-carrying bridge op)
   * @dev Cross-domain authenticated: callable only when the note can be proven to originate from the
   *      configured L1 pool (via the L2 messenger on OP-Stack, or address aliasing on Arbitrum).
   *      Records the note as pending and activates it immediately if its bridged tokens have already
   *      landed. Named `deposit` to match the wire selector the L1 pool encodes into the bridge
   *      message; it is not a public deposit. Payable so a native Arbitrum delivery can carry the
   *      bridged ETH as the retryable ticket's call value.
   * @param _value The note value carried in cleartext
   * @param _commitmentHash The destination-note commitment (C_dest)
   */
  function deposit(uint256 _value, uint256 _commitmentHash) external payable;

  /**
   * @notice Activate a pending note once its bridged tokens have landed, inserting it into the tree
   * @dev Permissionless. Enforces the backing invariant: spendable supply may never exceed the
   *      tokens received from the bridge.
   * @param _commitmentHash The pending note commitment to activate
   */
  function activateNote(uint256 _commitmentHash) external;

  /**
   * @notice Privately spend a delivered note, exiting its full value to a clear recipient
   * @dev Permissionless but bound to the request `processooor` (relayer) via the proof context.
   * @param _withdrawal The withdrawal request
   * @param _proof The L2 withdrawal proof
   */
  function withdraw(Withdrawal calldata _withdrawal, L2ProofLib.WithdrawProof calldata _proof) external;
}

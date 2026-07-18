// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/*

Made with ♥ for 0xBow by

░██╗░░░░░░░██╗░█████╗░███╗░░██╗██████╗░███████╗██████╗░██╗░░░░░░█████╗░███╗░░██╗██████╗░
░██║░░██╗░░██║██╔══██╗████╗░██║██╔══██╗██╔════╝██╔══██╗██║░░░░░██╔══██╗████╗░██║██╔══██╗
░╚██╗████╗██╔╝██║░░██║██╔██╗██║██║░░██║█████╗░░██████╔╝██║░░░░░███████║██╔██╗██║██║░░██║
░░████╔═████║░██║░░██║██║╚████║██║░░██║██╔══╝░░██╔══██╗██║░░░░░██╔══██║██║╚████║██║░░██║
░░╚██╔╝░╚██╔╝░╚█████╔╝██║░╚███║██████╔╝███████╗██║░░██║███████╗██║░░██║██║░╚███║██████╔╝
░░░╚═╝░░░╚═╝░░░╚════╝░╚═╝░░╚══╝╚═════╝░╚══════╝╚═╝░░╚═╝╚══════╝╚═╝░░╚═╝╚═╝░░╚══╝╚═════╝░

https://defi.sucks/

*/

import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';
import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';

import {InternalLeanIMT, LeanIMTData} from '@zk-kit/lean-imt.sol/InternalLeanIMT.sol';

import {Constants} from '../lib/Constants.sol';
import {L2ProofLib} from '../lib/L2ProofLib.sol';

import {IL2PrivacyPool} from 'interfaces/IL2PrivacyPool.sol';
import {IL2Verifier} from 'interfaces/IL2Verifier.sol';
import {IL2CrossDomainMessenger} from 'interfaces/external/IL2CrossDomainMessenger.sol';

/**
 * @title L2PrivacyPool
 * @notice Destination-side shielded pool: the delivery end of a Mode 3 L1->L2 withdrawal.
 * @dev Receives notes and tokens from the L1 pool over the canonical (OP-Stack) bridge and lets
 *      recipients privately spend a delivered note to a clear address. No public deposits, no ASP
 *      check, no change notes.
 *
 *      Safety rests on two guards:
 *        - Cross-domain auth: note messages are accepted only from the L2 messenger relaying a
 *          message whose original L1 sender is the configured L1 pool.
 *        - Backing invariant: a note is inserted as *pending* on arrival and becomes *spendable*
 *          only once matching bridged tokens have landed. Spendable supply can never exceed the
 *          tokens received from the bridge, which makes the unordered two-op delivery safe.
 *
 *      A single contract serves native and ERC20 pools via runtime branching on `IS_NATIVE`, and
 *      reuses the same BN254/Poseidon note format as L1 (the tree stores the L1-computed `C_dest`).
 */
contract L2PrivacyPool is ReentrancyGuard, IL2PrivacyPool {
  using SafeERC20 for IERC20;
  using InternalLeanIMT for LeanIMTData;
  using L2ProofLib for L2ProofLib.WithdrawProof;

  /// @notice The number of recent state roots kept for inclusion-proof validity
  uint32 public constant ROOT_HISTORY_SIZE = 64;
  /// @notice The maximum state tree depth (must match the circuit)
  uint32 public constant MAX_TREE_DEPTH = 32;

  /// @notice The pool asset (`Constants.NATIVE_ASSET` for the native asset)
  address public immutable ASSET;
  /// @notice Whether this pool holds the native asset
  bool public immutable IS_NATIVE;
  /// @notice Unique pool identifier binding proofs to this deployment
  uint256 public immutable SCOPE;
  /// @notice The L1 pool authorized to deliver notes over the bridge
  address public immutable L1_POOL;
  /// @notice The maximum relay fee, in basis points
  uint256 public immutable MAX_RELAY_FEE_BPS;

  /// @notice The OP-Stack L2 cross-domain messenger delivering L1 note messages
  IL2CrossDomainMessenger public immutable MESSENGER;
  /// @notice The Groth16 verifier for L2 withdrawal proofs
  IL2Verifier public immutable WITHDRAWAL_VERIFIER;

  /// @notice The L2 state tree of activated (spendable) destination notes
  LeanIMTData internal _merkleTree;
  /// @notice Circular buffer of recent state roots
  mapping(uint256 _index => uint256 _root) public roots;
  /// @notice The index of the latest stored root in the circular buffer
  uint32 public currentRootIndex;

  /// @notice Spent nullifiers
  mapping(uint256 _nullifierHash => bool _spent) public nullifierHashes;

  /// @notice Value of a received-but-not-yet-activated note, keyed by commitment (0 if none)
  mapping(uint256 _commitment => uint256 _value) public pendingValue;
  /// @notice Whether a commitment has ever been delivered (guards against duplicate messages)
  mapping(uint256 _commitment => bool _known) public receivedCommitments;

  /// @notice Cumulative value of all notes ever activated (monotonically increasing)
  uint256 public activatedSupply;
  /// @notice Cumulative value ever withdrawn out of the pool (monotonically increasing)
  uint256 public totalWithdrawn;

  /**
   * @notice Initialize the pool
   * @param _asset The pool asset (`Constants.NATIVE_ASSET` for native)
   * @param _l1Pool The L1 pool authorized to deliver notes
   * @param _messenger The L2 cross-domain messenger
   * @param _withdrawalVerifier The Groth16 verifier for withdrawals
   * @param _maxRelayFeeBPS The maximum allowed relay fee in basis points
   */
  constructor(
    address _asset,
    address _l1Pool,
    address _messenger,
    address _withdrawalVerifier,
    uint256 _maxRelayFeeBPS
  ) {
    if (_asset == address(0)) revert ZeroAddress();
    if (_l1Pool == address(0)) revert ZeroAddress();
    // `_messenger` may be zero for bridge families that authenticate without a messenger
    // (e.g. Arbitrum, which relays via address aliasing). Such deployments override
    // `_authenticateNote` and never touch `MESSENGER`; an OP-Stack pool left with a zero
    // messenger simply fails closed on every `deposit`.
    if (_withdrawalVerifier == address(0)) revert ZeroAddress();

    ASSET = _asset;
    IS_NATIVE = _asset == Constants.NATIVE_ASSET;
    L1_POOL = _l1Pool;
    MESSENGER = IL2CrossDomainMessenger(_messenger);
    WITHDRAWAL_VERIFIER = IL2Verifier(_withdrawalVerifier);
    MAX_RELAY_FEE_BPS = _maxRelayFeeBPS;

    SCOPE = uint256(keccak256(abi.encodePacked(address(this), block.chainid, _asset))) % Constants.SNARK_SCALAR_FIELD;
  }

  /*///////////////////////////////////////////////////////////////
                            NOTE INTAKE
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IL2PrivacyPool
  /// @dev Payable so a native Arbitrum delivery can carry the bridged ETH as the retryable
  ///      ticket's call value in the same message; OP-Stack sends value separately via `receive`.
  function deposit(uint256 _value, uint256 _commitmentHash) external payable {
    // Cross-domain auth: prove this note was relayed by the configured L1 pool. The proof
    // differs per bridge family (messenger vs. address aliasing), so it lives in a hook.
    _authenticateNote();

    // Reject duplicate deliveries of the same commitment
    if (receivedCommitments[_commitmentHash]) revert NoteAlreadyReceived();
    receivedCommitments[_commitmentHash] = true;
    pendingValue[_commitmentHash] = _value;

    emit NoteReceived(_commitmentHash, _value);

    // Activate immediately if the bridged tokens have already landed
    _tryActivate(_commitmentHash);
  }

  /**
   * @notice Authenticate that a `deposit` note was relayed by the configured L1 pool.
   * @dev OP-Stack default: the note must arrive through the L2 cross-domain messenger whose
   *      original L1 sender is `L1_POOL`. Bridge families that authenticate differently (Arbitrum
   *      address aliasing) override this hook. Reverts if the sender cannot be proven to be `L1_POOL`.
   */
  function _authenticateNote() internal view virtual {
    if (msg.sender != address(MESSENGER)) revert NotMessenger();
    if (MESSENGER.xDomainMessageSender() != L1_POOL) revert NotL1Pool();
  }

  /// @inheritdoc IL2PrivacyPool
  function activateNote(uint256 _commitmentHash) external {
    if (pendingValue[_commitmentHash] == 0) revert NoteNotPending();
    if (!_tryActivate(_commitmentHash)) revert NoteNotBacked();
  }

  /*///////////////////////////////////////////////////////////////
                            WITHDRAWALS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IL2PrivacyPool
  function withdraw(
    Withdrawal calldata _withdrawal,
    L2ProofLib.WithdrawProof calldata _proof
  ) external nonReentrant {
    // Only the designated relayer may submit; binds the proof to a specific caller
    if (_withdrawal.processooor != msg.sender) revert InvalidProcessooor();

    // Bind the request to the proof
    if (_proof.context() != uint256(keccak256(abi.encode(_withdrawal, SCOPE))) % Constants.SNARK_SCALAR_FIELD) {
      revert ContextMismatch();
    }
    if (_proof.stateTreeDepth() > MAX_TREE_DEPTH) revert InvalidTreeDepth();
    if (!_isKnownRoot(_proof.stateRoot())) revert UnknownStateRoot();

    uint256 _value = _proof.withdrawnValue();
    if (_value == 0) revert InvalidWithdrawalAmount();

    // Verify the Groth16 proof
    if (!WITHDRAWAL_VERIFIER.verifyProof(_proof.pA, _proof.pB, _proof.pC, _proof.pubSignals)) revert InvalidProof();

    // Spend the note
    _spend(_proof.nullifierHash());

    // Decode relay data and validate the fee
    RelayData memory _data = abi.decode(_withdrawal.data, (RelayData));
    if (_data.relayFeeBPS > MAX_RELAY_FEE_BPS) revert RelayFeeGreaterThanMax();

    // Account the exit against received backing before moving funds
    totalWithdrawn += _value;

    // Split value into the recipient amount and the relay fee
    uint256 _amountAfterFees = _deductFee(_value, _data.relayFeeBPS);
    uint256 _feeAmount = _value - _amountAfterFees;

    _transferOut(_data.recipient, _amountAfterFees);
    if (_feeAmount != 0) _transferOut(_data.feeRecipient, _feeAmount);

    emit Withdrawn(_data.recipient, _proof.nullifierHash(), _value, _feeAmount);
  }

  /*///////////////////////////////////////////////////////////////
                               VIEWS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice The current L2 state root
   * @return _root The current root
   */
  function currentRoot() external view returns (uint256 _root) {
    _root = _merkleTree._root();
  }

  /**
   * @notice The current L2 state tree depth
   * @return _depth The current depth
   */
  function currentTreeDepth() external view returns (uint256 _depth) {
    _depth = _merkleTree.depth;
  }

  /**
   * @notice The current L2 state tree size
   * @return _size The current size
   */
  function currentTreeSize() external view returns (uint256 _size) {
    _size = _merkleTree.size;
  }

  /**
   * @notice The total tokens received from the bridge (still held plus already withdrawn)
   * @dev Nothing but the bridge adds asset to this pool, so cumulative receipts equal the current
   *      balance plus everything ever withdrawn. This is the ceiling for spendable supply.
   * @return _received The cumulative tokens received from the bridge
   */
  function tokensReceivedFromBridge() public view returns (uint256 _received) {
    uint256 _balance = IS_NATIVE ? address(this).balance : IERC20(ASSET).balanceOf(address(this));
    _received = _balance + totalWithdrawn;
  }

  /*///////////////////////////////////////////////////////////////
                            INTERNAL LOGIC
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Activate a pending note if its bridged tokens have landed
   * @dev Enforces the backing invariant `activatedSupply + value <= tokensReceivedFromBridge`.
   * @param _commitmentHash The pending note commitment
   * @return _activated Whether the note was activated
   */
  function _tryActivate(uint256 _commitmentHash) internal returns (bool _activated) {
    uint256 _value = pendingValue[_commitmentHash];
    if (_value == 0) return false;

    // Backing invariant: never let spendable supply exceed tokens actually received
    if (activatedSupply + _value > tokensReceivedFromBridge()) return false;

    activatedSupply += _value;
    delete pendingValue[_commitmentHash];

    _insert(_commitmentHash);

    emit NoteActivated(_commitmentHash, _value);
    _activated = true;
  }

  /**
   * @notice Mark a nullifier as spent
   * @param _nullifierHash The nullifier to spend
   */
  function _spend(uint256 _nullifierHash) internal {
    if (nullifierHashes[_nullifierHash]) revert NullifierAlreadySpent();
    nullifierHashes[_nullifierHash] = true;
  }

  /**
   * @notice Insert a leaf into the state tree and record the new root in the history buffer
   * @param _leaf The leaf to insert
   * @return _updatedRoot The new root
   */
  function _insert(uint256 _leaf) internal returns (uint256 _updatedRoot) {
    _updatedRoot = _merkleTree._insert(_leaf);
    if (_merkleTree.depth > MAX_TREE_DEPTH) revert InvalidTreeDepth();

    uint32 _nextIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
    roots[_nextIndex] = _updatedRoot;
    currentRootIndex = _nextIndex;
  }

  /**
   * @notice Whether a root is in the recent history buffer
   * @param _root The root to check
   * @return Whether the root is known
   */
  function _isKnownRoot(uint256 _root) internal view returns (bool) {
    if (_root == 0) return false;

    uint32 _index = currentRootIndex;
    for (uint32 _i = 0; _i < ROOT_HISTORY_SIZE; _i++) {
      if (_root == roots[_index]) return true;
      _index = (_index + ROOT_HISTORY_SIZE - 1) % ROOT_HISTORY_SIZE;
    }
    return false;
  }

  /**
   * @notice Transfer an asset out of the pool, branching on asset type
   * @param _recipient The recipient
   * @param _amount The amount
   */
  function _transferOut(address _recipient, uint256 _amount) internal {
    if (IS_NATIVE) {
      (bool _success,) = _recipient.call{value: _amount}('');
      if (!_success) revert FailedToSendNativeAsset();
    } else {
      IERC20(ASSET).safeTransfer(_recipient, _amount);
    }
  }

  /**
   * @notice Deduct a basis-point fee from an amount
   * @param _amount The amount before fees
   * @param _feeBPS The fee in basis points
   * @return _afterFees The amount after fees
   */
  function _deductFee(uint256 _amount, uint256 _feeBPS) internal pure returns (uint256 _afterFees) {
    _afterFees = _amount - ((_amount * _feeBPS) / 10_000);
  }

  /// @notice Accept native asset delivered by the L2 standard bridge
  receive() external payable {}
}

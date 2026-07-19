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

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@oz/utils/ReentrancyGuard.sol';

import {PoseidonT4} from 'poseidon/PoseidonT4.sol';

import {Constants} from './lib/Constants.sol';
import {ProofLib} from './lib/ProofLib.sol';

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IL2Pool} from 'interfaces/IL2Pool.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';
import {IInbox, IL1GatewayRouter} from 'interfaces/external/IArbitrumBridge.sol';
import {IL1CrossDomainMessenger, IL1StandardBridge} from 'interfaces/external/IOptimismAdapter.sol';
import {IStarkgateBridge, IStarkgateEthBridge} from 'interfaces/external/IStarknetBridge.sol';

import {State} from './State.sol';

/**
 * @title PrivacyPool
 * @notice Allows publicly depositing and privately withdrawing funds, holding its own funds and
 *         bridging withdrawn value to a destination L2 shielded pool via the canonical messenger.
 * @dev A single contract handles both native asset and ERC20 pools via runtime branching on `ASSET`.
 *      Configuration (fees, ASP root, canonical bridge addresses) is read from the Registry
 *      (`ENTRYPOINT`) via view calls; no value ever routes through the Registry.
 * @dev Withdrawals require a valid proof of being approved by an ASP.
 * @dev Deposits can be irreversibly suspended by the Registry, while withdrawals can't.
 */
contract PrivacyPool is State, ReentrancyGuard, IPrivacyPool {
  using SafeERC20 for IERC20;
  using ProofLib for ProofLib.WithdrawProof;
  using ProofLib for ProofLib.RagequitProof;

  /// @notice L1 token identifier used by StarkGate's upgraded legacy ETH bridge.
  address internal constant STARKGATE_ETH = address(0x455448);

  /// @notice Whether this pool holds the native asset
  bool public immutable IS_NATIVE;

  /// @notice Accrued vetting fees held by the pool, withdrawable by the Registry owner
  uint256 public accruedFees;

  /// @notice Tracks used precommitments to prevent duplicate deposits
  mapping(uint256 _precommitment => bool _used) public usedPrecommitments;

  /**
   * @notice Initializes the contract state addresses
   * @param _entrypoint Address of the Registry that configures this pool
   * @param _withdrawalVerifier Address of the Groth16 verifier for withdrawal proofs
   * @param _ragequitVerifier Address of the Groth16 verifier for ragequit proofs
   * @param _asset Address of the pool asset (`Constants.NATIVE_ASSET` for the native asset)
   */
  constructor(
    address _entrypoint,
    address _withdrawalVerifier,
    address _ragequitVerifier,
    address _asset
  ) State(_asset, _entrypoint, _withdrawalVerifier, _ragequitVerifier) {
    IS_NATIVE = _asset == Constants.NATIVE_ASSET;
  }

  /*///////////////////////////////////////////////////////////////
                             DEPOSITS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPrivacyPool
  function deposit(uint256 _precommitment) external payable nonReentrant returns (uint256 _commitment) {
    if (!IS_NATIVE) revert NativeAssetNotAccepted();
    // Native value is received directly as `msg.value`
    _commitment = _deposit(msg.value, _precommitment);
  }

  /// @inheritdoc IPrivacyPool
  function deposit(uint256 _value, uint256 _precommitment) external nonReentrant returns (uint256 _commitment) {
    if (IS_NATIVE) revert NativeAssetNotAccepted();
    // Pull the gross deposit from the caller
    IERC20(ASSET).safeTransferFrom(msg.sender, address(this), _value);
    _commitment = _deposit(_value, _precommitment);
  }

  /*///////////////////////////////////////////////////////////////
                            WITHDRAWALS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPrivacyPool
  function relay(
    Withdrawal calldata _withdrawal,
    ProofLib.WithdrawProof calldata _proof
  ) external payable nonReentrant {
    // Check deposits/withdrawals integrity
    if (_proof.context() != uint256(keccak256(abi.encode(_withdrawal, SCOPE))) % Constants.SNARK_SCALAR_FIELD) {
      revert ContextMismatch();
    }
    if (_proof.stateTreeDepth() > MAX_TREE_DEPTH || _proof.ASPTreeDepth() > MAX_TREE_DEPTH) revert InvalidTreeDepth();
    if (!_isKnownRoot(_proof.stateRoot())) revert UnknownStateRoot();
    if (_proof.ASPRoot() != ENTRYPOINT.latestRoot()) revert IncorrectASPRoot();

    uint256 _withdrawnValue = _proof.withdrawnValue();
    if (_withdrawnValue == 0) revert InvalidWithdrawalAmount();

    // Verify proof with Groth16 verifier
    if (!WITHDRAWAL_VERIFIER.verifyProof(_proof.pA, _proof.pB, _proof.pC, _proof.pubSignals)) revert InvalidProof();

    // Mark existing commitment nullifier as spent and insert the new L1 change note
    _spend(_proof.existingNullifierHash());
    _insert(_proof.newCommitmentHashL1());

    // Decode relay data and validate the relay fee
    RelayData memory _data = abi.decode(_withdrawal.data, (RelayData));
    (,,, uint256 _maxRelayFeeBPS) = ENTRYPOINT.assetConfig(IERC20(ASSET));
    if (_data.relayFeeBPS > _maxRelayFeeBPS) revert RelayFeeGreaterThanMax();

    // Split withdrawn value into bridged amount and relay fee
    uint256 _amountAfterFees = _deductFee(_withdrawnValue, _data.relayFeeBPS);
    uint256 _feeAmount = _withdrawnValue - _amountAfterFees;

    if (_proof.bridgedValue() != _amountAfterFees) revert BridgedValueMismatch();

    uint256 _newCommitmentHashL2 = _proof.newCommitmentHashL2();

    // Bridge withdrawn funds directly to the destination L2 pool (the bridge lock). Returns the
    // amount of the caller-supplied `msg.value` consumed as L1->L2 message/gas fees (0 for OP-Stack).
    uint256 _feeSpent = _bridge(_withdrawal.chainId, _amountAfterFees, _newCommitmentHashL2);

    // Pay the relayer fee directly from the pool
    if (_feeAmount != 0) _transferOut(_data.feeRecipient, _feeAmount);

    // Refund any unused L1->L2 gas budget back to the relayer
    uint256 _refund = msg.value - _feeSpent;
    if (_refund != 0) _sendNative(msg.sender, _refund);

    emit Withdrawn(_proof.newCommitmentHashL1(), _newCommitmentHashL2, _withdrawnValue, _proof.existingNullifierHash());
    emit WithdrawalRelayed(msg.sender, _data.recipient, _withdrawnValue, _feeAmount);
    emit L2Note(_newCommitmentHashL2, _data.ephemeralKey, _data.viewTag);
  }

  /// @inheritdoc IPrivacyPool
  function ragequit(ProofLib.RagequitProof memory _proof) external nonReentrant {
    // Check if caller is original depositor
    uint256 _label = _proof.label();
    if (depositors[_label] != msg.sender) revert OnlyOriginalDepositor();

    // Verify proof with Groth16 verifier
    if (!RAGEQUIT_VERIFIER.verifyProof(_proof.pA, _proof.pB, _proof.pC, _proof.pubSignals)) revert InvalidProof();

    // Check commitment exists in state
    if (!_isInState(_proof.commitmentHash())) revert InvalidCommitment();

    // Mark existing commitment nullifier as spent
    _spend(_proof.nullifierHash());

    // Transfer out funds to ragequitter
    _transferOut(msg.sender, _proof.value());

    emit Ragequit(msg.sender, _proof.commitmentHash(), _proof.label(), _proof.value());
  }

  /*///////////////////////////////////////////////////////////////
                          FEES / WIND DOWN
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPrivacyPool
  function withdrawFees(address _recipient) external nonReentrant {
    if (!ENTRYPOINT.isOwner(msg.sender)) revert OnlyRegistryOwner();
    if (_recipient == address(0)) revert ZeroAddress();

    uint256 _amount = accruedFees;
    accruedFees = 0;

    _transferOut(_recipient, _amount);

    emit FeesWithdrawn(_recipient, _amount);
  }

  /// @inheritdoc IPrivacyPool
  function windDown() external onlyEntrypoint {
    // Check pool is still alive
    if (dead) revert PoolIsDead();

    // Die
    dead = true;

    emit PoolDied();
  }

  /*///////////////////////////////////////////////////////////////
                        INTERNAL METHODS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Handle deposit logic shared by native and ERC20 deposits
   * @param _value The gross deposited amount
   * @param _precommitment The precommitment hash
   * @return _commitment The deposit commitment hash
   */
  function _deposit(uint256 _value, uint256 _precommitment) internal returns (uint256 _commitment) {
    // Check deposits are enabled
    if (dead) revert PoolIsDead();

    // Fetch configuration from the Registry
    (, uint256 _minimumDepositAmount, uint256 _vettingFeeBPS,) = ENTRYPOINT.assetConfig(IERC20(ASSET));

    // Check the precommitment has not been used
    if (usedPrecommitments[_precommitment]) revert PrecommitmentAlreadyUsed();
    usedPrecommitments[_precommitment] = true;

    // Check minimum deposit amount against the gross value
    if (_value < _minimumDepositAmount) revert MinimumDepositAmount();

    // Deduct vetting fees, accruing them in the pool
    uint256 _amountAfterFees = _deductFee(_value, _vettingFeeBPS);
    accruedFees += _value - _amountAfterFees;

    if (_amountAfterFees >= type(uint128).max) revert InvalidDepositValue();

    // Compute label
    uint256 _label = uint256(keccak256(abi.encodePacked(SCOPE, ++nonce))) % Constants.SNARK_SCALAR_FIELD;
    // Store depositor
    depositors[_label] = msg.sender;

    // Compute commitment hash
    _commitment = PoseidonT4.hash([_amountAfterFees, _label, _precommitment]);

    // Insert commitment in state (revert if already present)
    _insert(_commitment);

    emit Deposited(msg.sender, _commitment, _label, _amountAfterFees, _precommitment);
  }

  /**
   * @notice Bridge withdrawn value to the destination L2 pool and carry the note message
   * @dev Reads canonical bridge configuration from the Registry and dispatches on the bridge family.
   *      OP-Stack and ERC20 Arbitrum use separate asynchronous deliveries. Native Arbitrum uses one
   *      retryable, and Starknet uses one atomic StarkGate token+callback delivery.
   * @param _chainId The destination chain id
   * @param _value The amount to bridge
   * @param _commitment The L2 destination-note commitment hash (C_dest)
   * @return _feeSpent The amount of the caller-supplied `msg.value` consumed as L1->L2 fees
   */
  function _bridge(uint256 _chainId, uint256 _value, uint256 _commitment) internal returns (uint256 _feeSpent) {
    IEntrypoint.BridgeConfig memory _config = ENTRYPOINT.getBridgeConfig(_chainId, ASSET);
    if (!_config.isSupported) revert UnsupportedChain();

    if (_config.kind == IEntrypoint.BridgeKind.OpStack) {
      _bridgeOpStack(_config, _value, _commitment);
      _feeSpent = 0;
    } else if (_config.kind == IEntrypoint.BridgeKind.Arbitrum) {
      _feeSpent = _bridgeArbitrum(_config, _value, _commitment);
    } else {
      _feeSpent = _bridgeStarknet(_config, _value, _commitment);
    }
  }

  /**
   * @notice Bridge to an OP-Stack chain (Optimism, Base) via the canonical messenger + standard
   *         bridge. The note message executes from L1-derived gas, so no ETH fee is prepaid.
   */
  function _bridgeOpStack(IEntrypoint.BridgeConfig memory _config, uint256 _value, uint256 _commitment) internal {
    // Initiate backing first. The two L2 operations remain asynchronous, but this ordering gives
    // the canonical token bridge the earliest possible inclusion and avoids deliberately putting
    // an unbacked commitment in flight first.
    if (IS_NATIVE) {
      IL1StandardBridge(_config.l1TokenBridge).bridgeETHTo{value: _value}(
        _config.l2Pool, uint32(_config.tokenGasLimit), bytes('')
      );
    } else {
      IERC20(ASSET).forceApprove(_config.l1TokenBridge, _value);
      IL1StandardBridge(_config.l1TokenBridge)
        .bridgeERC20To(ASSET, _config.l2Token, _config.l2Pool, _value, uint32(_config.tokenGasLimit), bytes(''));
    }

    // Send the commitment only after the backing bridge call has succeeded.
    bytes memory _message = abi.encodeWithSelector(IL2Pool.deposit.selector, _value, _commitment);
    IL1CrossDomainMessenger(_config.l1Messenger).sendMessage(_config.l2Pool, _message, uint32(_config.messageGasLimit));
  }

  /**
   * @notice Bridge to an Arbitrum chain via Delayed Inbox retryable tickets + L1 Gateway Router.
   * @dev Each L1->L2 op prepays `submissionCost + gasLimit * maxFeePerGas` in ETH from `msg.value`.
   *      Native ETH rides as the retryable's `l2CallValue`, so the note and the value are delivered
   *      by a single ticket; ERC20 uses a separate note ticket plus a gateway token transfer.
   */
  function _bridgeArbitrum(
    IEntrypoint.BridgeConfig memory _config,
    uint256 _value,
    uint256 _commitment
  ) internal returns (uint256 _feeSpent) {
    uint256 _msgFee = _config.messageFee + _config.messageGasLimit * _config.messageMaxFeePerGas;
    bytes memory _message = abi.encodeWithSelector(IL2Pool.deposit.selector, _value, _commitment);

    if (IS_NATIVE) {
      // The bridged ETH (`_value`) is pool principal; only the message fee comes from `msg.value`
      if (msg.value < _msgFee) revert InsufficientBridgeFee();
      IInbox(_config.l1Messenger).createRetryableTicket{value: _msgFee + _value}(
        _config.l2Pool,
        _value,
        _config.messageFee,
        msg.sender,
        msg.sender,
        _config.messageGasLimit,
        _config.messageMaxFeePerGas,
        _message
      );
      _feeSpent = _msgFee;
    } else {
      uint256 _tokenFee = _config.tokenFee + _config.tokenGasLimit * _config.tokenMaxFeePerGas;
      if (msg.value < _msgFee + _tokenFee) revert InsufficientBridgeFee();

      // Initiate the token retryable first, then the commitment retryable.
      _bridgeArbitrumToken(_config, _value, _tokenFee);

      IInbox(_config.l1Messenger).createRetryableTicket{value: _msgFee}(
        _config.l2Pool,
        0,
        _config.messageFee,
        msg.sender,
        msg.sender,
        _config.messageGasLimit,
        _config.messageMaxFeePerGas,
        _message
      );
      _feeSpent = _msgFee + _tokenFee;
    }
  }

  /**
   * @notice Lock an ERC20 into an Arbitrum destination through the token's canonical gateway
   * @dev Split out of `_bridgeArbitrum` to bound stack depth. The token allowance must target the
   *      gateway returned by the router, not the router itself.
   */
  function _bridgeArbitrumToken(IEntrypoint.BridgeConfig memory _config, uint256 _value, uint256 _tokenFee) internal {
    address _gateway = IL1GatewayRouter(_config.l1TokenBridge).getGateway(ASSET);
    IERC20(ASSET).forceApprove(_gateway, _value);
    IL1GatewayRouter(_config.l1TokenBridge).outboundTransferCustomRefund{value: _tokenFee}(
      ASSET,
      msg.sender,
      _config.l2Pool,
      _value,
      _config.tokenGasLimit,
      _config.tokenMaxFeePerGas,
      abi.encode(_config.tokenFee, bytes(''))
    );
  }

  /**
   * @notice Bridge to Starknet with StarkGate `depositWithMessage`.
   * @dev StarkGate credits the L2 token balance before invoking the destination pool's `on_receive`,
   *      making token-before-commitment ordering atomic. The commitment is split into low/high
   *      128-bit felts because a BN254 field element can exceed Starknet's felt252 range.
   */
  function _bridgeStarknet(
    IEntrypoint.BridgeConfig memory _config,
    uint256 _value,
    uint256 _commitment
  ) internal returns (uint256 _feeSpent) {
    if (msg.value < _config.tokenFee) revert InsufficientBridgeFee();

    uint256[] memory _message = new uint256[](2);
    _message[0] = _commitment & type(uint128).max;
    _message[1] = _commitment >> 128;

    // `depositWithMessage` mints/transfers backing first and then calls `on_receive` on the pool.
    if (IS_NATIVE) {
      IStarkgateEthBridge(_config.l1TokenBridge).depositWithMessage{value: _value + _config.tokenFee}(
        STARKGATE_ETH, _value, _config.l2PoolFelt, _message
      );
    } else {
      IERC20(ASSET).forceApprove(_config.l1TokenBridge, _value);
      IStarkgateBridge(_config.l1TokenBridge).depositWithMessage{value: _config.tokenFee}(
        ASSET, _value, _config.l2PoolFelt, _message
      );
    }

    _feeSpent = _config.tokenFee;
  }

  /**
   * @notice Transfer an asset out of the pool, branching on asset type
   * @param _recipient The recipient address
   * @param _amount The amount to send
   */
  function _transferOut(address _recipient, uint256 _amount) internal {
    if (IS_NATIVE) {
      _sendNative(_recipient, _amount);
    } else {
      IERC20(ASSET).safeTransfer(_recipient, _amount);
    }
  }

  /**
   * @notice Send native asset, reverting on failure
   * @dev Used both for native-asset payouts and for refunding unused L1->L2 gas budget to relayers,
   *      independent of the pool's asset type.
   * @param _recipient The recipient address
   * @param _amount The amount to send
   */
  function _sendNative(address _recipient, uint256 _amount) internal {
    (bool _success,) = _recipient.call{value: _amount}('');
    if (!_success) revert FailedToSendNativeAsset();
  }

  /**
   * @notice Deduct fees from an amount
   * @param _amount The amount before fees
   * @param _feeBPS The fee in basis points
   * @return _afterFees The amount after fees are deducted
   */
  function _deductFee(uint256 _amount, uint256 _feeBPS) internal pure returns (uint256 _afterFees) {
    _afterFees = _amount - ((_amount * _feeBPS) / 10_000);
  }
}

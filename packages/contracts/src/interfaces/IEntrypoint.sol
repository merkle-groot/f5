// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from '@oz/interfaces/IERC20.sol';

import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

/**
 * @title IEntrypoint
 * @notice Interface for the Entrypoint, which acts as a fund-free Registry for a series of
 *         ASP-operated Privacy Pools: it stores pool discovery, ASP association sets, per-asset
 *         fee configuration and per-chain bridge configuration. No value ever routes through it;
 *         pools hold their own funds and read this configuration via view calls.
 */
interface IEntrypoint {
  /*///////////////////////////////////////////////////////////////
                              ENUMS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice The canonical-bridge family a destination chain belongs to. Selects which inlined
   *         bridge code path the pool uses in `_bridge`.
   * @param OpStack OP-Stack chains (Optimism, Base): L1CrossDomainMessenger + L1StandardBridge.
   *        The note message executes from L1-derived gas, so no ETH fee is prepaid.
   * @param Arbitrum Arbitrum One/Nova: Delayed Inbox retryable tickets + L1 Gateway Router.
   *        Each L1->L2 op prepays `submissionCost + gasLimit * maxFeePerGas` in ETH.
   * @param Starknet Starknet: one StarkGate `depositWithMessage` operation. The destination address
   *        is a felt and the commitment callback is serialized as two felts.
   */
  enum BridgeKind {
    OpStack,
    Arbitrum,
    Starknet
  }

  /*///////////////////////////////////////////////////////////////
                              STRUCTS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Struct for the asset configuration
   * @param pool The Privacy Pool contract for the asset
   * @param minimumDepositAmount The minimum amount that can be deposited
   * @param vettingFeeBPS The deposit fee in basis points
   * @param maxRelayFeeBPS The maximum relay fee in basis points
   */
  struct AssetConfig {
    IPrivacyPool pool;
    uint256 minimumDepositAmount;
    uint256 vettingFeeBPS;
    uint256 maxRelayFeeBPS;
  }

  /**
   * @notice Per-(chain, token) canonical bridge configuration read by pools when bridging to L2.
   * @dev A single flat struct spans all three bridge families; the meaning of several fields depends
   *      on `kind` (documented per field). Fields unused by a given kind are left zero. Config is set
   *      rarely by the Registry owner, so the union layout is preferred over per-kind storage.
   * @param kind The bridge family (selects the pool's inlined bridge code path)
   * @param isSupported Whether the destination chain/token is enabled
   * @param l1Messenger L1 messaging endpoint.
   *        OpStack: L1CrossDomainMessenger | Arbitrum: Inbox | Starknet: unused
   * @param l1TokenBridge L1 token-bridge endpoint.
   *        OpStack: L1StandardBridge | Arbitrum: L1GatewayRouter | Starknet: StarkGate bridge
   * @param l2Pool Destination shielded pool as an EVM address (OpStack/Arbitrum). Unused for Starknet.
   * @param l2PoolFelt Destination shielded pool as a felt252 (Starknet). Unused otherwise.
   * @param l2Handler Legacy Starknet `l1_handler` selector. Unused by `depositWithMessage` and EVM bridges.
   * @param l2Token Remote (L2) token address (OpStack/Arbitrum ERC20). Unused for native / Starknet.
   * @param messageGasLimit Note-message L2 gas limit.
   *        OpStack: minGasLimit | Arbitrum: retryable gasLimit | Starknet: unused
   * @param messageMaxFeePerGas Note-message L2 max fee per gas. Arbitrum only; unused otherwise.
   * @param messageFee Prepaid ETH fee for the note message.
   *        Arbitrum: maxSubmissionCost | OpStack/Starknet: unused (0)
   * @param tokenGasLimit Token-bridge L2 gas limit.
   *        OpStack: minGasLimit | Arbitrum: gateway maxGas | Starknet: unused
   * @param tokenMaxFeePerGas Token-bridge L2 max fee per gas. Arbitrum only (gasPriceBid); unused otherwise.
   * @param tokenFee Prepaid ETH fee for the token bridge op.
   *        Arbitrum: maxSubmissionCost | Starknet: total depositWithMessage fee | OpStack: unused (0)
   */
  struct BridgeConfig {
    BridgeKind kind;
    bool isSupported;
    address l1Messenger;
    address l1TokenBridge;
    address l2Pool;
    uint256 l2PoolFelt;
    uint256 l2Handler;
    address l2Token;
    uint256 messageGasLimit;
    uint256 messageMaxFeePerGas;
    uint256 messageFee;
    uint256 tokenGasLimit;
    uint256 tokenMaxFeePerGas;
    uint256 tokenFee;
  }

  /**
   * @notice Struct for the onchain association set data
   * @param root The ASP root
   * @param ipfsCID The IPFS v1 CID of the ASP data.
   * @param timestamp The timestamp on which the root was updated
   */
  struct AssociationSetData {
    uint256 root;
    string ipfsCID;
    uint256 timestamp;
  }

  /*///////////////////////////////////////////////////////////////
                              EVENTS
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Emitted when pushing a new root to the association root set
   */
  event RootUpdated(uint256 _root, string _ipfsCID, uint256 _timestamp);

  /**
   * @notice Emitted when winding down a Privacy Pool
   */
  event PoolWindDown(IPrivacyPool _pool);

  /**
   * @notice Emitted when registering a Privacy Pool in the registry
   */
  event PoolRegistered(IPrivacyPool _pool, IERC20 _asset, uint256 _scope);

  /**
   * @notice Emitted when removing a Privacy Pool from the registry
   */
  event PoolRemoved(IPrivacyPool _pool, IERC20 _asset, uint256 _scope);

  /**
   * @notice Emitted when updating the configuration of a Privacy Pool
   */
  event PoolConfigurationUpdated(
    IPrivacyPool _pool,
    IERC20 _asset,
    uint256 _newMinimumDepositAmount,
    uint256 _newVettingFeeBPS,
    uint256 _newMaxRelayFeeBPS
  );

  /**
   * @notice Emitted when setting the canonical bridge configuration for a chain/token
   */
  event BridgeConfigSet(uint256 indexed _chainId, address indexed _token);

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  //////////////////////////////////////////////////////////////*/

  /// @notice Thrown when trying to access a non-existent pool
  error PoolNotFound();
  /// @notice Thrown when trying to register a dead pool
  error PoolIsDead();
  /// @notice Thrown when trying to register a pool whose configured Entrypoint is not this one
  error InvalidEntrypointForPool();
  /// @notice Thrown when trying to register a pool for an asset that is already present
  error AssetPoolAlreadyRegistered();
  /// @notice Thrown when trying to register a pool for a scope that is already present
  error ScopePoolAlreadyRegistered();
  /// @notice Thrown when trying to push an IPFS CID with an invalid length
  error InvalidIPFSCIDLength();
  /// @notice Thrown when trying to push an empty root
  error EmptyRoot();
  /// @notice Thrown when an address parameter is zero
  error ZeroAddress();
  /// @notice Thrown when a fee in basis points is greater than 10000 (100%)
  error InvalidFeeBPS();
  /// @notice Thrown when trying to access an association set at an invalid index
  error InvalidIndex();
  /// @notice Thrown when trying to get the latest root when no roots exist
  error NoRootsAvailable();
  /// @notice Thrown when the pool's asset doesn't match the registered asset
  error AssetMismatch();

  /*//////////////////////////////////////////////////////////////
                                LOGIC
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Initializes the contract state
   * @param _owner The initial owner
   * @param _postman The initial postman
   */
  function initialize(address _owner, address _postman) external;

  /**
   * @notice Push a new root to the association root set
   */
  function updateRoot(uint256 _root, string memory _ipfsCID) external returns (uint256 _index);

  /**
   * @notice Register a Privacy Pool in the registry
   */
  function registerPool(
    IERC20 _asset,
    IPrivacyPool _pool,
    uint256 _minimumDepositAmount,
    uint256 _vettingFeeBPS,
    uint256 _maxRelayFeeBPS
  ) external;

  /**
   * @notice Remove a Privacy Pool from the registry
   */
  function removePool(IERC20 _asset) external;

  /**
   * @notice Updates the configuration of a specific pool
   */
  function updatePoolConfiguration(
    IERC20 _asset,
    uint256 _minimumDepositAmount,
    uint256 _vettingFeeBPS,
    uint256 _maxRelayFeeBPS
  ) external;

  /**
   * @notice Set the canonical bridge configuration for a destination chain/token
   */
  function setBridgeConfig(uint256 _chainId, address _token, BridgeConfig calldata _config) external;

  /**
   * @notice Irreversibly halt deposits from a Privacy Pool
   */
  function windDownPool(IPrivacyPool _pool) external;

  /*///////////////////////////////////////////////////////////////
                            VIEWS
  //////////////////////////////////////////////////////////////*/

  /// @notice Returns the configured pool for a scope
  function scopeToPool(uint256 _scope) external view returns (IPrivacyPool _pool);

  /// @notice Returns the configuration for an asset
  function assetConfig(IERC20 _asset)
    external
    view
    returns (IPrivacyPool _pool, uint256 _minimumDepositAmount, uint256 _vettingFeeBPS, uint256 _maxRelayFeeBPS);

  /// @notice Returns the canonical bridge configuration for a destination chain/token
  function getBridgeConfig(uint256 _chainId, address _token) external view returns (BridgeConfig memory _config);

  /// @notice Returns the association set data at an index
  function associationSets(uint256 _index)
    external
    view
    returns (uint256 _root, string memory _ipfsCID, uint256 _timestamp);

  /// @notice Returns the latest ASP root
  function latestRoot() external view returns (uint256 _root);

  /// @notice Returns an ASP root by index
  function rootByIndex(uint256 _index) external view returns (uint256 _root);

  /// @notice Returns whether an account holds the owner role
  function isOwner(address _account) external view returns (bool _owner);
}

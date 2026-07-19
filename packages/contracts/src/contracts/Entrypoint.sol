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

import {AccessControlUpgradeable} from '@oz-upgradeable/access/AccessControlUpgradeable.sol';
import {UUPSUpgradeable} from '@oz-upgradeable/proxy/utils/UUPSUpgradeable.sol';
import {ReentrancyGuardUpgradeable} from '@oz-upgradeable/utils/ReentrancyGuardUpgradeable.sol';

import {IERC20} from '@oz/interfaces/IERC20.sol';

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

/**
 * @title Entrypoint
 * @notice Fund-free Registry for a series of ASP-operated Privacy Pools. Stores pool discovery,
 *         ASP association sets, per-asset fee configuration and per-chain canonical bridge
 *         configuration. Pools hold their own funds and read this configuration via view calls;
 *         no value ever routes through this contract.
 */
contract Entrypoint is AccessControlUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable, IEntrypoint {
  /// @dev 0xb19546dff01e856fb3f010c267a7b1c60363cf8a4664e21cc89c26224620214e
  bytes32 internal constant _OWNER_ROLE = keccak256('OWNER_ROLE');
  /// @dev 0xfc84ade01695dae2ade01aa4226dc40bdceaf9d5dbd3bf8630b1dd5af195bbc5
  bytes32 internal constant _ASP_POSTMAN = keccak256('ASP_POSTMAN');

  /// @inheritdoc IEntrypoint
  mapping(uint256 _scope => IPrivacyPool _pool) public scopeToPool;

  /// @inheritdoc IEntrypoint
  mapping(IERC20 _asset => AssetConfig _config) public assetConfig;

  /// @inheritdoc IEntrypoint
  AssociationSetData[] public associationSets;

  /// @notice Canonical bridge configuration keyed by destination chain id and token
  mapping(uint256 _chainId => mapping(address _token => BridgeConfig _config)) internal _bridgeConfig;

  /*///////////////////////////////////////////////////////////////
                          INITIALIZATION
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Disables initializers. Using UUPS upgradeability pattern
   */
  constructor() {
    _disableInitializers();
  }

  /// @inheritdoc IEntrypoint
  function initialize(address _owner, address _postman) external initializer {
    // Sanity check initial addresses
    if (_owner == address(0)) revert ZeroAddress();
    if (_postman == address(0)) revert ZeroAddress();

    // Initialize upgradeable contracts
    __UUPSUpgradeable_init();
    __ReentrancyGuard_init();
    __AccessControl_init();

    // Initialize roles
    _setRoleAdmin(DEFAULT_ADMIN_ROLE, _OWNER_ROLE);
    _setRoleAdmin(_OWNER_ROLE, _OWNER_ROLE); // Owner can manage owner role
    _setRoleAdmin(_ASP_POSTMAN, _OWNER_ROLE); // Owner can manage postman role

    _grantRole(_OWNER_ROLE, _owner);
    _grantRole(_ASP_POSTMAN, _postman);
  }

  /*///////////////////////////////////////////////////////////////
                      ASSOCIATION SET METHODS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IEntrypoint
  function updateRoot(uint256 _root, string memory _ipfsCID) external onlyRole(_ASP_POSTMAN) returns (uint256 _index) {
    // Check provided values are non-zero
    if (_root == 0) revert EmptyRoot();
    uint256 _cidLength = bytes(_ipfsCID).length;
    if (_cidLength < 32 || _cidLength > 64) revert InvalidIPFSCIDLength();

    // Push new association set and update index
    associationSets.push(AssociationSetData(_root, _ipfsCID, block.timestamp));
    _index = associationSets.length - 1;

    emit RootUpdated(_root, _ipfsCID, block.timestamp);
  }

  /*///////////////////////////////////////////////////////////////
                          POOL MANAGEMENT
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IEntrypoint
  function registerPool(
    IERC20 _asset,
    IPrivacyPool _pool,
    uint256 _minimumDepositAmount,
    uint256 _vettingFeeBPS,
    uint256 _maxRelayFeeBPS
  ) external onlyRole(_OWNER_ROLE) {
    // Sanity check addresses
    if (address(_asset) == address(0)) revert ZeroAddress();
    if (address(_pool) == address(0)) revert ZeroAddress();

    // Fetch pool configuration
    AssetConfig storage _config = assetConfig[_asset];
    if (address(_config.pool) != address(0)) revert AssetPoolAlreadyRegistered();

    if (_pool.dead()) revert PoolIsDead();
    if (address(_pool.ENTRYPOINT()) != address(this)) revert InvalidEntrypointForPool();

    // Fetch pool scope and validate asset
    uint256 _scope = _pool.SCOPE();
    if (address(scopeToPool[_scope]) != address(0)) revert ScopePoolAlreadyRegistered();
    if (_asset != IERC20(_pool.ASSET())) revert AssetMismatch();

    // Store pool configuration
    scopeToPool[_scope] = _pool;
    _config.pool = _pool;

    // Update pool configuration with validation
    _setPoolConfiguration(_config, _minimumDepositAmount, _vettingFeeBPS, _maxRelayFeeBPS);

    emit PoolRegistered(_pool, _asset, _scope);
  }

  /// @inheritdoc IEntrypoint
  function removePool(IERC20 _asset) external onlyRole(_OWNER_ROLE) {
    // Fetch pool by asset
    IPrivacyPool _pool = assetConfig[_asset].pool;
    if (address(_pool) == address(0)) revert PoolNotFound();

    // Fetch pool scope
    uint256 _scope = _pool.SCOPE();

    // Remove pool configuration
    delete scopeToPool[_scope];
    delete assetConfig[_asset];

    emit PoolRemoved(_pool, _asset, _scope);
  }

  /// @inheritdoc IEntrypoint
  function updatePoolConfiguration(
    IERC20 _asset,
    uint256 _minimumDepositAmount,
    uint256 _vettingFeeBPS,
    uint256 _maxRelayFeeBPS
  ) external onlyRole(_OWNER_ROLE) {
    // Fetch pool configuration
    AssetConfig storage _config = assetConfig[_asset];
    if (address(_config.pool) == address(0)) revert PoolNotFound();

    // Update pool configuration with validation
    _setPoolConfiguration(_config, _minimumDepositAmount, _vettingFeeBPS, _maxRelayFeeBPS);

    emit PoolConfigurationUpdated(_config.pool, _asset, _minimumDepositAmount, _vettingFeeBPS, _maxRelayFeeBPS);
  }

  /// @inheritdoc IEntrypoint
  function setBridgeConfig(
    uint256 _chainId,
    address _token,
    BridgeConfig calldata _config
  ) external onlyRole(_OWNER_ROLE) {
    if (_config.isSupported) {
      // Starknet carries the note inside StarkGate `depositWithMessage`; EVM families retain
      // separate messaging and token-bridge endpoints.
      if (_config.kind == BridgeKind.Starknet) {
        if (_config.l1TokenBridge == address(0) || _config.l2PoolFelt == 0) revert ZeroAddress();
      } else {
        if (_config.l1Messenger == address(0) || _config.l1TokenBridge == address(0) || _config.l2Pool == address(0)) {
          revert ZeroAddress();
        }
      }
    }

    _bridgeConfig[_chainId][_token] = _config;

    emit BridgeConfigSet(_chainId, _token);
  }

  /// @inheritdoc IEntrypoint
  function windDownPool(IPrivacyPool _pool) external onlyRole(_OWNER_ROLE) {
    // Call `windDown` on pool
    _pool.windDown();

    emit PoolWindDown(_pool);
  }

  /*///////////////////////////////////////////////////////////////
                           VIEW METHODS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IEntrypoint
  function getBridgeConfig(uint256 _chainId, address _token) external view returns (BridgeConfig memory _config) {
    _config = _bridgeConfig[_chainId][_token];
  }

  /// @inheritdoc IEntrypoint
  function latestRoot() external view returns (uint256 _root) {
    if (associationSets.length == 0) revert NoRootsAvailable();
    _root = associationSets[associationSets.length - 1].root;
  }

  /// @inheritdoc IEntrypoint
  function rootByIndex(uint256 _index) external view returns (uint256 _root) {
    if (_index >= associationSets.length) revert InvalidIndex();
    _root = associationSets[_index].root;
  }

  /// @inheritdoc IEntrypoint
  function isOwner(address _account) external view returns (bool _owner) {
    _owner = hasRole(_OWNER_ROLE, _account);
  }

  /*///////////////////////////////////////////////////////////////
                        INTERNAL METHODS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc UUPSUpgradeable
  function _authorizeUpgrade(address) internal override onlyRole(_OWNER_ROLE) {}

  /**
   * @notice Sets pool configuration parameters with validation
   * @param _config The pool configuration to update
   * @param _minimumDepositAmount The new minimum deposit amount
   * @param _vettingFeeBPS The new vetting fee in basis points
   * @param _maxRelayFeeBPS The maximum relay fee in basis points
   */
  function _setPoolConfiguration(
    AssetConfig storage _config,
    uint256 _minimumDepositAmount,
    uint256 _vettingFeeBPS,
    uint256 _maxRelayFeeBPS
  ) internal {
    // Check fee is less than 100%
    if (_vettingFeeBPS >= 10_000 || _maxRelayFeeBPS >= 10_000) revert InvalidFeeBPS();

    _config.minimumDepositAmount = _minimumDepositAmount;
    _config.vettingFeeBPS = _vettingFeeBPS;
    _config.maxRelayFeeBPS = _maxRelayFeeBPS;
  }
}

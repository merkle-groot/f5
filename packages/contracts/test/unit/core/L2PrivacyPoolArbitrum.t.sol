// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';

import {L2PrivacyPoolArbitrum} from 'contracts/L2/L2PrivacyPoolArbitrum.sol';
import {AddressAliasHelper} from 'contracts/lib/AddressAliasHelper.sol';
import {Constants} from 'contracts/lib/Constants.sol';

import {IL2PrivacyPool} from 'interfaces/IL2PrivacyPool.sol';
import {IL2Verifier} from 'interfaces/IL2Verifier.sol';

import {ERC20} from '@oz/token/ERC20/ERC20.sol';

/// @notice Verifier stub (unused by intake tests, required by the constructor)
contract ArbMockVerifier is IL2Verifier {
  function verifyProof(
    uint256[2] memory,
    uint256[2][2] memory,
    uint256[2] memory,
    uint256[5] memory
  ) external pure returns (bool) {
    return true;
  }
}

contract ArbMockERC20 is ERC20 {
  constructor() ERC20('Mock', 'MOCK') {}

  function mint(address _to, uint256 _amount) external {
    _mint(_to, _amount);
  }
}

/// @notice Exercises the Arbitrum destination pool's alias-based auth and native single-ticket
///         delivery, driving `deposit` exactly as an executed retryable ticket would.
contract L2PrivacyPoolArbitrumTest is Test {
  uint256 internal constant MAX_FEE_BPS = 1000;

  ArbMockVerifier internal verifier;
  ArbMockERC20 internal token;

  L2PrivacyPoolArbitrum internal nativePool;
  L2PrivacyPoolArbitrum internal tokenPool;

  address internal l1Pool = makeAddr('l1Pool');
  /// @notice The `msg.sender` a retryable from `l1Pool` presents on L2
  address internal aliasedL1Pool;

  function setUp() public {
    verifier = new ArbMockVerifier();
    token = new ArbMockERC20();
    aliasedL1Pool = AddressAliasHelper.applyL1ToL2Alias(l1Pool);

    nativePool = new L2PrivacyPoolArbitrum(Constants.NATIVE_ASSET, l1Pool, address(verifier), MAX_FEE_BPS);
    tokenPool = new L2PrivacyPoolArbitrum(address(token), l1Pool, address(verifier), MAX_FEE_BPS);
  }

  function _c(bytes memory _seed) internal pure returns (uint256) {
    return uint256(keccak256(_seed)) % Constants.SNARK_SCALAR_FIELD;
  }

  /*//////////////////////////////////////////////////////////////
                              AUTH
  //////////////////////////////////////////////////////////////*/

  function test_AcceptsAliasedL1Sender() public {
    uint256 _commitment = _c('note');
    vm.prank(aliasedL1Pool);
    tokenPool.deposit(1 ether, _commitment);

    assertEq(tokenPool.pendingValue(_commitment), 1 ether);
    assertTrue(tokenPool.receivedCommitments(_commitment));
  }

  function test_RejectsUnaliasedL1Sender() public {
    // The raw (un-aliased) L1 address must NOT authenticate — only its alias does.
    vm.prank(l1Pool);
    vm.expectRevert(IL2PrivacyPool.NotL1Pool.selector);
    tokenPool.deposit(1 ether, _c('note'));
  }

  function test_RejectsForeignAliasedSender() public {
    address _attackerAlias = AddressAliasHelper.applyL1ToL2Alias(makeAddr('attacker'));
    vm.prank(_attackerAlias);
    vm.expectRevert(IL2PrivacyPool.NotL1Pool.selector);
    tokenPool.deposit(1 ether, _c('note'));
  }

  /*//////////////////////////////////////////////////////////////
                          NATIVE SINGLE TICKET
  //////////////////////////////////////////////////////////////*/

  function test_NativeSingleTicketDeliversValueAndActivatesInOneCall() public {
    // A native retryable carries the bridged ETH as the call's value alongside the note, so the
    // pool receives value and note atomically and activates immediately.
    uint256 _commitment = _c('native');
    vm.deal(aliasedL1Pool, 1 ether);
    vm.prank(aliasedL1Pool);
    nativePool.deposit{value: 1 ether}(1 ether, _commitment);

    assertEq(nativePool.pendingValue(_commitment), 0, 'no longer pending');
    assertEq(nativePool.activatedSupply(), 1 ether, 'activated');
    assertEq(nativePool.currentTreeSize(), 1, 'inserted into tree');
    assertEq(address(nativePool).balance, 1 ether, 'value credited as backing');
  }

  /*//////////////////////////////////////////////////////////////
                         ERC20 TWO-OP DELIVERY
  //////////////////////////////////////////////////////////////*/

  function test_Erc20NoteStaysPendingUntilGatewayTokensLand() public {
    // ERC20 uses two ops: the note ticket (no value) and a separate gateway token transfer.
    uint256 _commitment = _c('erc20');
    vm.prank(aliasedL1Pool);
    tokenPool.deposit(10 ether, _commitment);

    assertEq(tokenPool.pendingValue(_commitment), 10 ether, 'pending, unbacked');
    assertEq(tokenPool.currentTreeSize(), 0);

    // Gateway delivers the tokens, then activation succeeds.
    token.mint(address(tokenPool), 10 ether);
    tokenPool.activateNote(_commitment);

    assertEq(tokenPool.pendingValue(_commitment), 0);
    assertEq(tokenPool.activatedSupply(), 10 ether);
    assertEq(tokenPool.currentTreeSize(), 1);
  }

  function test_MessengerIsUnsetForArbitrum() public view {
    assertEq(address(nativePool.MESSENGER()), address(0));
  }
}

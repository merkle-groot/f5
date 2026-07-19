// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';
import {Vm} from 'forge-std/Vm.sol';

import {L2PrivacyPool} from 'contracts/L2/L2PrivacyPool.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {L2ProofLib} from 'contracts/lib/L2ProofLib.sol';

import {IL2PrivacyPool} from 'interfaces/IL2PrivacyPool.sol';
import {IL2Verifier} from 'interfaces/IL2Verifier.sol';

import {ERC20} from '@oz/token/ERC20/ERC20.sol';

/// @notice Verifier stub whose result is toggleable
contract MockL2Verifier is IL2Verifier {
  bool public result = true;

  function setResult(bool _r) external {
    result = _r;
  }

  function verifyProof(
    uint256[2] memory,
    uint256[2][2] memory,
    uint256[2] memory,
    uint256[5] memory
  ) external view returns (bool) {
    return result;
  }
}

/// @notice Simulates the OP-Stack L2 cross-domain messenger relaying an L1 message
contract MockL2Messenger {
  address public xDomainMessageSender;

  function setSender(address _s) external {
    xDomainMessageSender = _s;
  }

  /// @notice Relay a `deposit(value, commitment)` call to the pool as if from L1
  function relayNote(address _pool, uint256 _value, uint256 _commitment) external {
    IL2PrivacyPool(_pool).deposit(_value, _commitment);
  }
}

contract MockERC20 is ERC20 {
  constructor() ERC20('Mock', 'MOCK') {}

  function mint(address _to, uint256 _amount) external {
    _mint(_to, _amount);
  }
}

/// @notice A contract that rejects native transfers, to exercise the failed-send path
contract RejectEther {
  receive() external payable {
    revert('no');
  }
}

contract L2PrivacyPoolTest is Test {
  uint256 internal constant MAX_FEE_BPS = 1000; // 10%

  MockL2Verifier internal verifier;
  MockL2Messenger internal messenger;
  MockERC20 internal token;

  L2PrivacyPool internal nativePool;
  L2PrivacyPool internal tokenPool;

  address internal l1Pool = makeAddr('l1Pool');
  address internal relayer = makeAddr('relayer');
  address internal recipient = makeAddr('recipient');
  address internal feeRecipient = makeAddr('feeRecipient');

  function setUp() public {
    verifier = new MockL2Verifier();
    messenger = new MockL2Messenger();
    messenger.setSender(l1Pool);
    token = new MockERC20();

    nativePool =
      new L2PrivacyPool(Constants.NATIVE_ASSET, l1Pool, address(messenger), address(verifier), MAX_FEE_BPS);
    tokenPool = new L2PrivacyPool(address(token), l1Pool, address(messenger), address(verifier), MAX_FEE_BPS);
  }

  /*//////////////////////////////////////////////////////////////
                              INTAKE
  //////////////////////////////////////////////////////////////*/

  function test_NoteStaysPendingUntilTokensArrive() public {
    uint256 _commitment = _c('c1');
    messenger.relayNote(address(nativePool), 1 ether, _commitment);

    // Received but no tokens yet: still pending, not in the tree
    assertEq(nativePool.pendingValue(_commitment), 1 ether);
    assertEq(nativePool.activatedSupply(), 0);
    assertEq(nativePool.currentTreeSize(), 0);

    // Tokens land, then activation succeeds
    vm.deal(address(nativePool), 1 ether);
    nativePool.activateNote(_commitment);

    assertEq(nativePool.pendingValue(_commitment), 0);
    assertEq(nativePool.activatedSupply(), 1 ether);
    assertEq(nativePool.currentTreeSize(), 1);
    assertTrue(nativePool.currentRoot() != 0);
  }

  function test_NativeReceiptEmitsBackingSignal() public {
    vm.deal(address(this), 1 ether);

    vm.expectEmit(false, false, false, true, address(nativePool));
    emit IL2PrivacyPool.BackingReceived(1 ether, 1 ether);

    (bool _success,) = address(nativePool).call{value: 1 ether}('');
    assertTrue(_success);
  }

  function test_TokenPoolDoesNotEmitNativeBackingSignal() public {
    vm.deal(address(this), 1 ether);
    vm.recordLogs();

    (bool _success,) = address(tokenPool).call{value: 1 ether}('');
    assertTrue(_success);

    Vm.Log[] memory _logs = vm.getRecordedLogs();
    bytes32 _backingTopic = keccak256('BackingReceived(uint256,uint256)');
    for (uint256 _i; _i < _logs.length; ++_i) {
      assertTrue(_logs[_i].topics[0] != _backingTopic);
    }
  }

  function test_NoteAutoActivatesWhenTokensAlreadyLanded() public {
    // Tokens land first (unordered delivery), then the note message arrives
    vm.deal(address(nativePool), 2 ether);
    uint256 _commitment = _c('c2');
    messenger.relayNote(address(nativePool), 2 ether, _commitment);

    assertEq(nativePool.pendingValue(_commitment), 0);
    assertEq(nativePool.activatedSupply(), 2 ether);
    assertEq(nativePool.currentTreeSize(), 1);
  }

  function test_ActivationEnforcesBackingInvariant() public {
    // Two notes of 1 ether but only 1 ether of backing
    messenger.relayNote(address(nativePool), 1 ether, _c('a'));
    messenger.relayNote(address(nativePool), 1 ether, _c('b'));
    vm.deal(address(nativePool), 1 ether);

    nativePool.activateNote(_c('a'));
    assertEq(nativePool.activatedSupply(), 1 ether);

    // Second note is unbacked
    vm.expectRevert(IL2PrivacyPool.NoteNotBacked.selector);
    nativePool.activateNote(_c('b'));

    // More tokens arrive; now it activates
    vm.deal(address(nativePool), 2 ether);
    nativePool.activateNote(_c('b'));
    assertEq(nativePool.activatedSupply(), 2 ether);
    assertEq(nativePool.currentTreeSize(), 2);
  }

  function test_IntakeRejectsNonMessenger() public {
    vm.expectRevert(IL2PrivacyPool.NotMessenger.selector);
    nativePool.deposit(1 ether, uint256(keccak256('x')));
  }

  function test_IntakeRejectsForeignL1Sender() public {
    messenger.setSender(makeAddr('attacker'));
    vm.expectRevert(IL2PrivacyPool.NotL1Pool.selector);
    messenger.relayNote(address(nativePool), 1 ether, uint256(keccak256('x')));
  }

  function test_IntakeRejectsDuplicateCommitment() public {
    uint256 _commitment = _c('dup');
    messenger.relayNote(address(nativePool), 1 ether, _commitment);
    vm.expectRevert(IL2PrivacyPool.NoteAlreadyReceived.selector);
    messenger.relayNote(address(nativePool), 1 ether, _commitment);
  }

  /// @notice A commitment reduced into the SNARK field, as a real Poseidon `C_dest` would be
  function _c(bytes memory _seed) internal pure returns (uint256) {
    return uint256(keccak256(_seed)) % Constants.SNARK_SCALAR_FIELD;
  }

  /*//////////////////////////////////////////////////////////////
                            WITHDRAWAL
  //////////////////////////////////////////////////////////////*/

  function _buildWithdrawal(uint256 _relayFeeBPS) internal view returns (IL2PrivacyPool.Withdrawal memory _w) {
    _w.processooor = relayer;
    _w.data = abi.encode(IL2PrivacyPool.RelayData({recipient: recipient, feeRecipient: feeRecipient, relayFeeBPS: _relayFeeBPS}));
  }

  function _buildProof(
    L2PrivacyPool _pool,
    IL2PrivacyPool.Withdrawal memory _w,
    uint256 _value,
    uint256 _root
  ) internal view returns (L2ProofLib.WithdrawProof memory _p) {
    // Signal layout must match L2ProofLib: [0]=nullifierHash, [1]=withdrawnValue.
    _p.pubSignals[0] = uint256(keccak256('nullifier')) % Constants.SNARK_SCALAR_FIELD;
    _p.pubSignals[1] = _value;
    _p.pubSignals[2] = _root;
    _p.pubSignals[3] = 1;
    _p.pubSignals[4] = uint256(keccak256(abi.encode(_w, _pool.SCOPE()))) % Constants.SNARK_SCALAR_FIELD;
  }

  function test_WithdrawNativeExitsToRecipientMinusFee() public {
    uint256 _value = 4 ether;
    vm.deal(address(nativePool), _value);
    messenger.relayNote(address(nativePool), _value, _c('note'));
    uint256 _root = nativePool.currentRoot();

    IL2PrivacyPool.Withdrawal memory _w = _buildWithdrawal(500); // 5%
    L2ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, _value, _root);

    vm.prank(relayer);
    nativePool.withdraw(_w, _p);

    assertEq(recipient.balance, 3.8 ether);
    assertEq(feeRecipient.balance, 0.2 ether);
    assertEq(nativePool.totalWithdrawn(), _value);
    assertTrue(nativePool.nullifierHashes(_p.pubSignals[0]));
  }

  function test_WithdrawERC20ExitsThroughSafeTransfer() public {
    uint256 _value = 6 ether;
    token.mint(address(tokenPool), _value);
    messenger.relayNote(address(tokenPool), _value, _c('note-erc20'));
    uint256 _root = tokenPool.currentRoot();

    IL2PrivacyPool.Withdrawal memory _w = _buildWithdrawal(1000); // 10% == max
    L2ProofLib.WithdrawProof memory _p = _buildProof(tokenPool, _w, _value, _root);

    vm.prank(relayer);
    tokenPool.withdraw(_w, _p);

    assertEq(token.balanceOf(recipient), 5.4 ether);
    assertEq(token.balanceOf(feeRecipient), 0.6 ether);
    assertEq(token.balanceOf(address(tokenPool)), 0);
  }

  function test_WithdrawRejectsNonProcessooor() public {
    uint256 _value = 1 ether;
    vm.deal(address(nativePool), _value);
    messenger.relayNote(address(nativePool), _value, _c('n'));
    uint256 _root = nativePool.currentRoot();

    IL2PrivacyPool.Withdrawal memory _w = _buildWithdrawal(0);
    L2ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, _value, _root);

    vm.expectRevert(IL2PrivacyPool.InvalidProcessooor.selector);
    nativePool.withdraw(_w, _p); // called by this test contract, not the relayer
  }

  function test_WithdrawRejectsContextMismatch() public {
    uint256 _value = 1 ether;
    vm.deal(address(nativePool), _value);
    messenger.relayNote(address(nativePool), _value, _c('n'));
    uint256 _root = nativePool.currentRoot();

    IL2PrivacyPool.Withdrawal memory _w = _buildWithdrawal(0);
    L2ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, _value, _root);
    _p.pubSignals[4] = uint256(keccak256('wrong-context'));

    vm.prank(relayer);
    vm.expectRevert(IL2PrivacyPool.ContextMismatch.selector);
    nativePool.withdraw(_w, _p);
  }

  function test_WithdrawRejectsUnknownRoot() public {
    uint256 _value = 1 ether;
    vm.deal(address(nativePool), _value);
    messenger.relayNote(address(nativePool), _value, _c('n'));

    IL2PrivacyPool.Withdrawal memory _w = _buildWithdrawal(0);
    L2ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, _value, uint256(keccak256('bogus-root')));

    vm.prank(relayer);
    vm.expectRevert(IL2PrivacyPool.UnknownStateRoot.selector);
    nativePool.withdraw(_w, _p);
  }

  function test_WithdrawRejectsDoubleSpend() public {
    uint256 _value = 2 ether;
    vm.deal(address(nativePool), _value);
    messenger.relayNote(address(nativePool), _value, _c('n'));
    uint256 _root = nativePool.currentRoot();

    IL2PrivacyPool.Withdrawal memory _w = _buildWithdrawal(0);
    L2ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, 1 ether, _root);

    vm.prank(relayer);
    nativePool.withdraw(_w, _p);

    // Reusing the same nullifier reverts
    vm.deal(address(nativePool), 1 ether);
    vm.prank(relayer);
    vm.expectRevert(IL2PrivacyPool.NullifierAlreadySpent.selector);
    nativePool.withdraw(_w, _p);
  }

  function test_WithdrawRejectsInvalidProof() public {
    uint256 _value = 1 ether;
    vm.deal(address(nativePool), _value);
    messenger.relayNote(address(nativePool), _value, _c('n'));
    uint256 _root = nativePool.currentRoot();

    IL2PrivacyPool.Withdrawal memory _w = _buildWithdrawal(0);
    L2ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, _value, _root);
    verifier.setResult(false);

    vm.prank(relayer);
    vm.expectRevert(IL2PrivacyPool.InvalidProof.selector);
    nativePool.withdraw(_w, _p);
  }

  function test_WithdrawRejectsFeeAboveMax() public {
    uint256 _value = 1 ether;
    vm.deal(address(nativePool), _value);
    messenger.relayNote(address(nativePool), _value, _c('n'));
    uint256 _root = nativePool.currentRoot();

    IL2PrivacyPool.Withdrawal memory _w = _buildWithdrawal(1001); // above 10% max
    L2ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, _value, _root);

    vm.prank(relayer);
    vm.expectRevert(IL2PrivacyPool.RelayFeeGreaterThanMax.selector);
    nativePool.withdraw(_w, _p);
  }

  function test_WithdrawRejectsExcessiveTreeDepth() public {
    uint256 _value = 1 ether;
    vm.deal(address(nativePool), _value);
    messenger.relayNote(address(nativePool), _value, _c('n'));
    uint256 _root = nativePool.currentRoot();

    IL2PrivacyPool.Withdrawal memory _w = _buildWithdrawal(0);
    L2ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, _value, _root);
    _p.pubSignals[3] = nativePool.MAX_TREE_DEPTH() + 1;

    vm.prank(relayer);
    vm.expectRevert(IL2PrivacyPool.InvalidTreeDepth.selector);
    nativePool.withdraw(_w, _p);
  }

  function test_WithdrawRejectsZeroAmount() public {
    uint256 _value = 1 ether;
    vm.deal(address(nativePool), _value);
    messenger.relayNote(address(nativePool), _value, _c('n'));
    uint256 _root = nativePool.currentRoot();

    IL2PrivacyPool.Withdrawal memory _w = _buildWithdrawal(0);
    L2ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, 0, _root);

    vm.prank(relayer);
    vm.expectRevert(IL2PrivacyPool.InvalidWithdrawalAmount.selector);
    nativePool.withdraw(_w, _p);
  }

  function test_WithdrawRevertsWhenNativeSendFails() public {
    uint256 _value = 1 ether;
    vm.deal(address(nativePool), _value);
    messenger.relayNote(address(nativePool), _value, _c('n'));
    uint256 _root = nativePool.currentRoot();

    address _rejector = address(new RejectEther());
    IL2PrivacyPool.Withdrawal memory _w;
    _w.processooor = relayer;
    _w.data = abi.encode(
      IL2PrivacyPool.RelayData({recipient: _rejector, feeRecipient: feeRecipient, relayFeeBPS: 0})
    );
    L2ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, _value, _root);

    vm.prank(relayer);
    vm.expectRevert(IL2PrivacyPool.FailedToSendNativeAsset.selector);
    nativePool.withdraw(_w, _p);
  }

  /*//////////////////////////////////////////////////////////////
                        ACTIVATION EDGE CASES
  //////////////////////////////////////////////////////////////*/

  function test_ActivateRejectsUnknownCommitment() public {
    vm.expectRevert(IL2PrivacyPool.NoteNotPending.selector);
    nativePool.activateNote(_c('never-delivered'));
  }

  function test_ActivateRejectsAlreadyActivatedNote() public {
    uint256 _commitment = _c('once');
    vm.deal(address(nativePool), 1 ether);
    messenger.relayNote(address(nativePool), 1 ether, _commitment); // auto-activates

    // No longer pending — a second activation reverts
    vm.expectRevert(IL2PrivacyPool.NoteNotPending.selector);
    nativePool.activateNote(_commitment);
  }

  /*//////////////////////////////////////////////////////////////
                        STATE / ACCOUNTING
  //////////////////////////////////////////////////////////////*/

  function test_OldRootStaysValidAfterMoreInsertions() public {
    // Activate one note and snapshot its root
    vm.deal(address(nativePool), 1 ether);
    messenger.relayNote(address(nativePool), 1 ether, _c('r1'));
    uint256 _oldRoot = nativePool.currentRoot();

    // Insert several more notes; the buffer keeps the old root within ROOT_HISTORY_SIZE
    for (uint256 _i = 2; _i <= 5; _i++) {
      vm.deal(address(nativePool), _i * 1 ether);
      messenger.relayNote(address(nativePool), 1 ether, _c(abi.encodePacked('r', _i)));
    }

    assertTrue(nativePool.currentRoot() != _oldRoot);

    // A proof built against the stale-but-recent root still verifies as known
    IL2PrivacyPool.Withdrawal memory _w = _buildWithdrawal(0);
    L2ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, 1 ether, _oldRoot);

    vm.prank(relayer);
    nativePool.withdraw(_w, _p); // does not revert on UnknownStateRoot
    assertTrue(nativePool.nullifierHashes(_p.pubSignals[0]));
  }

  function test_BackingCarriesAcrossWithdrawalsViaReceipts() public {
    // First note lands and is spent, draining the balance to 0
    vm.deal(address(nativePool), 1 ether);
    messenger.relayNote(address(nativePool), 1 ether, _c('first'));
    uint256 _root = nativePool.currentRoot();

    IL2PrivacyPool.Withdrawal memory _w = _buildWithdrawal(0);
    L2ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, 1 ether, _root);
    vm.prank(relayer);
    nativePool.withdraw(_w, _p);

    assertEq(address(nativePool).balance, 0);
    assertEq(nativePool.totalWithdrawn(), 1 ether);

    // A second note of 1 ether arrives with NO new tokens. Cumulative receipts still equal
    // balance(0) + totalWithdrawn(1) = 1, but activatedSupply is already 1, so it must stay pending.
    messenger.relayNote(address(nativePool), 1 ether, _c('second'));
    assertEq(nativePool.pendingValue(_c('second')), 1 ether);

    vm.expectRevert(IL2PrivacyPool.NoteNotBacked.selector);
    nativePool.activateNote(_c('second'));

    // Fresh bridged tokens raise receipts; now it activates.
    vm.deal(address(nativePool), 1 ether);
    nativePool.activateNote(_c('second'));
    assertEq(nativePool.activatedSupply(), 2 ether);
    assertEq(nativePool.pendingValue(_c('second')), 0);
  }

  /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
  //////////////////////////////////////////////////////////////*/

  function test_ConstructorRejectsZeroAsset() public {
    vm.expectRevert(IL2PrivacyPool.ZeroAddress.selector);
    new L2PrivacyPool(address(0), l1Pool, address(messenger), address(verifier), MAX_FEE_BPS);
  }

  function test_ConstructorRejectsZeroL1Pool() public {
    vm.expectRevert(IL2PrivacyPool.ZeroAddress.selector);
    new L2PrivacyPool(Constants.NATIVE_ASSET, address(0), address(messenger), address(verifier), MAX_FEE_BPS);
  }

  function test_ConstructorAllowsZeroMessengerButOpStackAuthFailsClosed() public {
    // A zero messenger is permitted so bridge families that authenticate without one (Arbitrum,
    // via address aliasing) can reuse this base. An OP-Stack pool built this way isn't unsafe: its
    // messenger-based auth simply fails closed on every intake, so no note can ever be delivered.
    L2PrivacyPool _pool =
      new L2PrivacyPool(Constants.NATIVE_ASSET, l1Pool, address(0), address(verifier), MAX_FEE_BPS);
    assertEq(address(_pool.MESSENGER()), address(0));

    vm.expectRevert(IL2PrivacyPool.NotMessenger.selector);
    _pool.deposit(1 ether, uint256(keccak256('x')));
  }

  function test_ConstructorRejectsZeroVerifier() public {
    vm.expectRevert(IL2PrivacyPool.ZeroAddress.selector);
    new L2PrivacyPool(Constants.NATIVE_ASSET, l1Pool, address(messenger), address(0), MAX_FEE_BPS);
  }

  function test_ConstructorSetsImmutables() public view {
    assertEq(nativePool.ASSET(), Constants.NATIVE_ASSET);
    assertTrue(nativePool.IS_NATIVE());
    assertEq(nativePool.L1_POOL(), l1Pool);
    assertEq(address(nativePool.MESSENGER()), address(messenger));
    assertEq(address(nativePool.WITHDRAWAL_VERIFIER()), address(verifier));
    assertEq(nativePool.MAX_RELAY_FEE_BPS(), MAX_FEE_BPS);

    assertEq(tokenPool.ASSET(), address(token));
    assertFalse(tokenPool.IS_NATIVE());

    // Scopes are deployment-unique (differ by asset even at the same address/chain)
    assertTrue(nativePool.SCOPE() != tokenPool.SCOPE());
  }
}

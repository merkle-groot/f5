// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';
import {Vm} from 'forge-std/Vm.sol';

import {ERC1967Proxy} from '@oz/proxy/ERC1967/ERC1967Proxy.sol';
import {ERC20} from '@oz/token/ERC20/ERC20.sol';
import {IERC20} from '@oz/interfaces/IERC20.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {PrivacyPool} from 'contracts/PrivacyPool.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IL2Pool} from 'interfaces/IL2Pool.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';
import {IVerifier} from 'interfaces/IVerifier.sol';

/*///////////////////////////////////////////////////////////////
                            MOCKS
//////////////////////////////////////////////////////////////*/

contract MintableERC20 is ERC20 {
  constructor() ERC20('Mock', 'MOCK') {}

  function mint(address _to, uint256 _amount) external {
    _mint(_to, _amount);
  }
}

/// @notice Always-true Groth16 verifier for both proof sizes
contract MockVerifier is IVerifier {
  function verifyProof(uint256[2] memory, uint256[2][2] memory, uint256[2] memory, uint256[10] memory)
    external
    pure
    returns (bool)
  {
    return true;
  }

  function verifyProof(uint256[2] memory, uint256[2][2] memory, uint256[2] memory, uint256[4] memory)
    external
    pure
    returns (bool)
  {
    return true;
  }
}

/// @notice Records the last cross-domain message
contract MockMessenger {
  address public lastTarget;
  bytes public lastMessage;

  function sendMessage(address _target, bytes calldata _message, uint32) external payable {
    lastTarget = _target;
    lastMessage = _message;
  }
}

/// @notice Simulates the OP-Stack standard bridge locking tokens on L1
contract MockStandardBridge {
  event ERC20Locked(address token, address to, uint256 amount);
  event ETHLocked(address to, uint256 amount);

  function bridgeERC20To(
    address _localToken,
    address,
    address _to,
    uint256 _amount,
    uint32,
    bytes calldata
  ) external {
    // Pulls the approved tokens from the caller (the pool), like the real bridge
    IERC20(_localToken).transferFrom(msg.sender, address(this), _amount);
    emit ERC20Locked(_localToken, _to, _amount);
  }

  function bridgeETHTo(address _to, uint32, bytes calldata) external payable {
    emit ETHLocked(_to, msg.value);
  }
}

/// @notice Simulates the Arbitrum Delayed Inbox
contract MockInbox {
  address public lastTo;
  uint256 public lastCallValue;
  uint256 public lastMsgValue;
  bytes public lastData;

  function createRetryableTicket(
    address _to,
    uint256 _l2CallValue,
    uint256,
    address,
    address,
    uint256,
    uint256,
    bytes calldata _data
  ) external payable returns (uint256) {
    lastTo = _to;
    lastCallValue = _l2CallValue;
    lastMsgValue = msg.value;
    lastData = _data;
    return 1;
  }
}

/// @notice Simulates the Arbitrum L1 Gateway Router (is its own gateway here) locking ERC20s
contract MockGatewayRouter {
  uint256 public lastFee;

  function getGateway(address) external view returns (address) {
    return address(this);
  }

  function outboundTransferCustomRefund(
    address _token,
    address,
    address,
    uint256 _amount,
    uint256,
    uint256,
    bytes calldata
  ) external payable returns (bytes memory) {
    lastFee = msg.value;
    IERC20(_token).transferFrom(msg.sender, address(this), _amount);
    return bytes('');
  }
}

/// @notice Simulates the Starknet Core messaging contract
contract MockStarknetCore {
  uint256 public lastToAddress;
  uint256 public lastSelector;
  uint256 public lastMsgValue;
  uint256[] internal _lastPayload;

  function sendMessageToL2(
    uint256 _toAddress,
    uint256 _selector,
    uint256[] calldata _payload
  ) external payable returns (bytes32, uint256) {
    lastToAddress = _toAddress;
    lastSelector = _selector;
    lastMsgValue = msg.value;
    _lastPayload = _payload;
    return (bytes32(0), 0);
  }

  function lastPayload() external view returns (uint256[] memory) {
    return _lastPayload;
  }
}

/// @notice Simulates the StarkGate token bridge (native + ERC20)
contract MockStarkgate {
  address internal immutable ERC20_TOKEN;
  uint256 public lastAmount;
  uint256 public lastRecipient;
  uint256 public lastMsgValue;

  constructor(address _erc20) {
    ERC20_TOKEN = _erc20;
  }

  function deposit(address _token, uint256 _amount, uint256 _l2Recipient) external payable {
    lastAmount = _amount;
    lastRecipient = _l2Recipient;
    lastMsgValue = msg.value;
    // ERC20 is pulled from the pool; native rides in msg.value
    if (_token == ERC20_TOKEN) IERC20(_token).transferFrom(msg.sender, address(this), _amount);
  }
}

/*///////////////////////////////////////////////////////////////
                            TESTS
//////////////////////////////////////////////////////////////*/

/**
 * @notice End-to-end unit tests for the merged Pool + Registry flow, proving that a withdrawal
 *         moves principal exactly once (to the bridge) plus a single fee transfer — no
 *         Pool -> Entrypoint -> Adapter hops.
 */
contract MergedFlowTest is Test {
  using ProofLib for ProofLib.WithdrawProof;

  Entrypoint internal registry;
  PrivacyPool internal nativePool;
  PrivacyPool internal tokenPool;
  MintableERC20 internal token;

  MockVerifier internal verifier;
  MockMessenger internal messenger;
  MockStandardBridge internal bridge;
  MockInbox internal inbox;
  MockGatewayRouter internal gatewayRouter;
  MockStarknetCore internal starknetCore;
  MockStarkgate internal starkgate;

  address internal owner = makeAddr('owner');
  address internal postman = makeAddr('postman');
  address internal depositor = makeAddr('depositor');
  address internal relayer = makeAddr('relayer');
  address internal recipient = makeAddr('recipient');
  address internal feeRecipient = makeAddr('feeRecipient');
  address internal l2Pool = makeAddr('l2Pool');

  uint256 internal constant DEST_CHAIN = 10; // OP-Stack (Optimism)
  uint256 internal constant ARB_CHAIN = 42_161; // Arbitrum One
  uint256 internal constant SN_CHAIN = 777; // Starknet (opaque key)
  uint256 internal constant SN_POOL_FELT = 0x1234abcd; // destination Cairo pool (felt)
  uint256 internal constant SN_HANDLER = 0x00beef; // l1_handler selector (felt)
  uint256 internal constant SN_MSG_FEE = 0.001 ether;
  uint256 internal constant SN_TOKEN_FEE = 0.002 ether;
  uint256 internal constant ARB_MSG_FEE = 0.001 ether;
  uint256 internal constant ARB_TOKEN_FEE = 0.002 ether;
  uint256 internal constant VETTING_FEE_BPS = 100; // 1%
  uint256 internal constant MAX_RELAY_FEE_BPS = 1000; // 10%

  function setUp() public {
    verifier = new MockVerifier();
    messenger = new MockMessenger();
    bridge = new MockStandardBridge();
    inbox = new MockInbox();
    gatewayRouter = new MockGatewayRouter();
    starknetCore = new MockStarknetCore();
    token = new MintableERC20();
    starkgate = new MockStarkgate(address(token));

    // Deploy Registry behind a proxy
    Entrypoint _impl = new Entrypoint();
    bytes memory _init = abi.encodeCall(Entrypoint.initialize, (owner, postman));
    registry = Entrypoint(payable(address(new ERC1967Proxy(address(_impl), _init))));

    // Deploy pools
    nativePool = new PrivacyPool(address(registry), address(verifier), address(verifier), Constants.NATIVE_ASSET);
    tokenPool = new PrivacyPool(address(registry), address(verifier), address(verifier), address(token));

    vm.startPrank(owner);
    registry.registerPool(IERC20(Constants.NATIVE_ASSET), nativePool, 1 ether, VETTING_FEE_BPS, MAX_RELAY_FEE_BPS);
    registry.registerPool(IERC20(address(token)), tokenPool, 1 ether, VETTING_FEE_BPS, MAX_RELAY_FEE_BPS);

    // OP-Stack config (no L1->L2 fee)
    IEntrypoint.BridgeConfig memory _op = IEntrypoint.BridgeConfig({
      kind: IEntrypoint.BridgeKind.OpStack,
      isSupported: true,
      l1Messenger: address(messenger),
      l1TokenBridge: address(bridge),
      l2Pool: l2Pool,
      l2PoolFelt: 0,
      l2Handler: 0,
      l2Token: makeAddr('l2Token'),
      messageGasLimit: 100_000,
      messageMaxFeePerGas: 0,
      messageFee: 0,
      tokenGasLimit: 100_000,
      tokenMaxFeePerGas: 0,
      tokenFee: 0
    });
    registry.setBridgeConfig(DEST_CHAIN, Constants.NATIVE_ASSET, _op);
    registry.setBridgeConfig(DEST_CHAIN, address(token), _op);

    // Arbitrum config (Inbox + Gateway Router; flat ETH fees, gas terms zeroed for simple math)
    IEntrypoint.BridgeConfig memory _arb = IEntrypoint.BridgeConfig({
      kind: IEntrypoint.BridgeKind.Arbitrum,
      isSupported: true,
      l1Messenger: address(inbox),
      l1TokenBridge: address(gatewayRouter),
      l2Pool: l2Pool,
      l2PoolFelt: 0,
      l2Handler: 0,
      l2Token: makeAddr('l2Token'),
      messageGasLimit: 0,
      messageMaxFeePerGas: 0,
      messageFee: ARB_MSG_FEE,
      tokenGasLimit: 0,
      tokenMaxFeePerGas: 0,
      tokenFee: ARB_TOKEN_FEE
    });
    registry.setBridgeConfig(ARB_CHAIN, Constants.NATIVE_ASSET, _arb);
    registry.setBridgeConfig(ARB_CHAIN, address(token), _arb);

    // Starknet config (Core messaging + StarkGate; flat ETH fees; felt destination)
    IEntrypoint.BridgeConfig memory _sn = IEntrypoint.BridgeConfig({
      kind: IEntrypoint.BridgeKind.Starknet,
      isSupported: true,
      l1Messenger: address(starknetCore),
      l1TokenBridge: address(starkgate),
      l2Pool: address(0),
      l2PoolFelt: SN_POOL_FELT,
      l2Handler: SN_HANDLER,
      l2Token: address(0),
      messageGasLimit: 0,
      messageMaxFeePerGas: 0,
      messageFee: SN_MSG_FEE,
      tokenGasLimit: 0,
      tokenMaxFeePerGas: 0,
      tokenFee: SN_TOKEN_FEE
    });
    registry.setBridgeConfig(SN_CHAIN, Constants.NATIVE_ASSET, _sn);
    registry.setBridgeConfig(SN_CHAIN, address(token), _sn);
    vm.stopPrank();

    // Seed an ASP root
    vm.prank(postman);
    registry.updateRoot(uint256(keccak256('asp')), 'QmXoc9M9d2b6h9pQb3aQ2z1n8zQwv3rXpQ2y9dQ2z1n8zX');
  }

  /*//////////////////////////////////////////////////////////////
                            DEPOSITS
  //////////////////////////////////////////////////////////////*/

  function test_NativeDepositAccruesFeeAndHoldsFunds() public {
    vm.deal(depositor, 10 ether);

    vm.prank(depositor);
    nativePool.deposit{value: 10 ether}(uint256(keccak256('precommit-1')));

    // 1% vetting fee accrues; the whole gross value stays in the pool
    assertEq(nativePool.accruedFees(), 0.1 ether);
    assertEq(address(nativePool).balance, 10 ether);
  }

  function test_ERC20DepositPullsGrossOnce() public {
    token.mint(depositor, 10 ether);

    vm.startPrank(depositor);
    token.approve(address(tokenPool), 10 ether);
    tokenPool.deposit(10 ether, uint256(keccak256('precommit-2')));
    vm.stopPrank();

    assertEq(token.balanceOf(address(tokenPool)), 10 ether);
    assertEq(tokenPool.accruedFees(), 0.1 ether);
  }

  function test_ERC20DepositOnNativePoolReverts() public {
    vm.prank(depositor);
    vm.expectRevert(IPrivacyPool.NativeAssetNotAccepted.selector);
    nativePool.deposit(1 ether, uint256(keccak256('x')));
  }

  /*//////////////////////////////////////////////////////////////
                         WITHDRAWAL / RELAY
  //////////////////////////////////////////////////////////////*/

  function _buildWithdrawal(uint256 _relayFeeBPS) internal view returns (IPrivacyPool.Withdrawal memory _w) {
    _w = _buildWithdrawalChain(DEST_CHAIN, _relayFeeBPS);
  }

  function _buildWithdrawalChain(
    uint256 _chainId,
    uint256 _relayFeeBPS
  ) internal view returns (IPrivacyPool.Withdrawal memory _w) {
    uint256[2] memory _ephemeralKey = [uint256(1), uint256(2)];
    IPrivacyPool.RelayData memory _data = IPrivacyPool.RelayData({
      recipient: recipient,
      feeRecipient: feeRecipient,
      ephemeralKey: _ephemeralKey,
      viewTag: bytes1(0xAB),
      relayFeeBPS: _relayFeeBPS
    });
    _w = IPrivacyPool.Withdrawal({chainId: _chainId, data: abi.encode(_data)});
  }

  function _buildProof(
    PrivacyPool _pool,
    IPrivacyPool.Withdrawal memory _w,
    uint256 _withdrawnValue
  ) internal view returns (ProofLib.WithdrawProof memory _p) {
    // Signal layout must match ProofLib (the contract's source of truth).
    IPrivacyPool.RelayData memory _data = abi.decode(_w.data, (IPrivacyPool.RelayData));
    _p.pubSignals[0] = uint256(keccak256('newL1')) % Constants.SNARK_SCALAR_FIELD; // new L1 change note
    _p.pubSignals[1] = uint256(keccak256('newL2')) % Constants.SNARK_SCALAR_FIELD; // C_dest
    _p.pubSignals[2] = uint256(keccak256('nullifier')) % Constants.SNARK_SCALAR_FIELD; // existing nullifier
    _p.pubSignals[3] = _withdrawnValue; // withdrawn value
    _p.pubSignals[4] = _withdrawnValue - ((_withdrawnValue * _data.relayFeeBPS) / 10_000); // net bridged value
    _p.pubSignals[5] = _pool.currentRoot(); // state root (known after deposit)
    _p.pubSignals[6] = 1; // state tree depth
    _p.pubSignals[7] = registry.latestRoot(); // ASP root
    _p.pubSignals[8] = 1; // ASP tree depth
    _p.pubSignals[9] = uint256(keccak256(abi.encode(_w, _pool.SCOPE()))) % Constants.SNARK_SCALAR_FIELD; // context
  }

  function test_NativeRelayBridgesOnceAndPaysFeeOnce() public {
    vm.deal(depositor, 10 ether);
    vm.prank(depositor);
    nativePool.deposit{value: 10 ether}(uint256(keccak256('precommit-native')));

    IPrivacyPool.Withdrawal memory _w = _buildWithdrawal(500); // 5%
    ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, 1 ether);

    uint256 _bridgeBalBefore = address(bridge).balance;

    vm.prank(relayer);
    nativePool.relay(_w, _p);

    // 5% of 1 ether = 0.05 fee, 0.95 bridged
    assertEq(feeRecipient.balance, 0.05 ether, 'fee paid once');
    assertEq(address(bridge).balance - _bridgeBalBefore, 0.95 ether, 'bridged once');
    assertEq(address(nativePool).balance, 9 ether, 'pool paid exactly the withdrawn value');
    // Note message carried to the correct L2 pool as a valid `deposit(uint256,uint256)` call
    assertEq(messenger.lastTarget(), l2Pool);
    bytes memory _message = messenger.lastMessage();
    assertEq(bytes4(_message), IL2Pool.deposit.selector, 'message is a deposit() call');
    (uint256 _bridgedValue, uint256 _commitment) = abi.decode(_slice4(_message), (uint256, uint256));
    assertEq(_bridgedValue, 0.95 ether, 'message carries the bridged value');
    assertEq(_commitment, _p.pubSignals[1], 'message carries C_dest');
  }

  /// @notice Drop the leading 4-byte selector from an ABI-encoded call, returning the argument tail
  function _slice4(bytes memory _data) internal pure returns (bytes memory _args) {
    _args = new bytes(_data.length - 4);
    for (uint256 _i = 0; _i < _args.length; _i++) {
      _args[_i] = _data[_i + 4];
    }
  }

  function test_ERC20RelayMovesPrincipalExactlyOnce() public {
    token.mint(depositor, 10 ether);
    vm.startPrank(depositor);
    token.approve(address(tokenPool), 10 ether);
    tokenPool.deposit(10 ether, uint256(keccak256('precommit-token')));
    vm.stopPrank();

    IPrivacyPool.Withdrawal memory _w = _buildWithdrawal(500);
    ProofLib.WithdrawProof memory _p = _buildProof(tokenPool, _w, 1 ether);

    vm.recordLogs();
    vm.prank(relayer);
    tokenPool.relay(_w, _p);
    Vm.Log[] memory _logs = vm.getRecordedLogs();

    // Count ERC20 Transfer events originating from the pool
    bytes32 _transferSig = keccak256('Transfer(address,address,uint256)');
    uint256 _poolTransfers;
    bool _sentToRegistry;
    for (uint256 _i; _i < _logs.length; ++_i) {
      if (_logs[_i].emitter == address(token) && _logs[_i].topics[0] == _transferSig) {
        address _from = address(uint160(uint256(_logs[_i].topics[1])));
        address _to = address(uint160(uint256(_logs[_i].topics[2])));
        if (_from == address(tokenPool)) {
          _poolTransfers++;
          if (_to == address(registry)) _sentToRegistry = true;
        }
      }
    }

    // Exactly two outgoing transfers: bridge lock + relayer fee. No Pool -> Entrypoint hop.
    assertEq(_poolTransfers, 2, 'principal + fee, no intermediate hop');
    assertFalse(_sentToRegistry, 'funds never route through the registry');
    assertEq(token.balanceOf(feeRecipient), 0.05 ether);
    assertEq(token.balanceOf(address(bridge)), 0.95 ether);
  }

  function test_RelayRevertsWhenRelayFeeExceedsMax() public {
    vm.deal(depositor, 10 ether);
    vm.prank(depositor);
    nativePool.deposit{value: 10 ether}(uint256(keccak256('precommit-fee')));

    IPrivacyPool.Withdrawal memory _w = _buildWithdrawal(MAX_RELAY_FEE_BPS + 1);
    ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, 1 ether);

    vm.prank(relayer);
    vm.expectRevert(IPrivacyPool.RelayFeeGreaterThanMax.selector);
    nativePool.relay(_w, _p);
  }

  function test_RelayRevertsOnUnsupportedChain() public {
    vm.deal(depositor, 10 ether);
    vm.prank(depositor);
    nativePool.deposit{value: 10 ether}(uint256(keccak256('precommit-chain')));

    IPrivacyPool.Withdrawal memory _w = _buildWithdrawal(500);
    _w.chainId = 9999; // not configured
    // _buildProof binds context over this (already-mutated) withdrawal.
    ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, 1 ether);

    vm.prank(relayer);
    vm.expectRevert(IPrivacyPool.UnsupportedChain.selector);
    nativePool.relay(_w, _p);
  }

  /*//////////////////////////////////////////////////////////////
                       ARBITRUM / STARKNET BRIDGES
  //////////////////////////////////////////////////////////////*/

  function test_ArbitrumNativeRelayDeliversValueAndNoteInOneTicket() public {
    vm.deal(depositor, 10 ether);
    vm.prank(depositor);
    nativePool.deposit{value: 10 ether}(uint256(keccak256('precommit-arb-native')));

    IPrivacyPool.Withdrawal memory _w = _buildWithdrawalChain(ARB_CHAIN, 500); // 5%
    ProofLib.WithdrawProof memory _p = _buildProof(nativePool, _w, 1 ether);

    vm.deal(relayer, 1 ether);
    vm.prank(relayer);
    nativePool.relay{value: ARB_MSG_FEE}(_w, _p);

    // Native value rides as retryable l2CallValue; msg.value = fee + bridged value
    assertEq(inbox.lastTo(), l2Pool, 'note+value ticket targets the L2 pool');
    assertEq(inbox.lastCallValue(), 0.95 ether, 'bridged value delivered as l2CallValue');
    assertEq(inbox.lastMsgValue(), ARB_MSG_FEE + 0.95 ether, 'fee + value forwarded to the inbox');
    // Relayer only funds the message fee; the value comes from pool principal
    assertEq(relayer.balance, 1 ether - ARB_MSG_FEE, 'relayer charged exactly the message fee');
    assertEq(feeRecipient.balance, 0.05 ether, 'relay fee paid once');
    assertEq(address(nativePool).balance, 9 ether, 'pool paid exactly the withdrawn value');
  }

  function test_ArbitrumERC20RelayLocksThroughGateway() public {
    token.mint(depositor, 10 ether);
    vm.startPrank(depositor);
    token.approve(address(tokenPool), 10 ether);
    tokenPool.deposit(10 ether, uint256(keccak256('precommit-arb-token')));
    vm.stopPrank();

    IPrivacyPool.Withdrawal memory _w = _buildWithdrawalChain(ARB_CHAIN, 500);
    ProofLib.WithdrawProof memory _p = _buildProof(tokenPool, _w, 1 ether);

    vm.deal(relayer, 1 ether);
    vm.prank(relayer);
    tokenPool.relay{value: ARB_MSG_FEE + ARB_TOKEN_FEE}(_w, _p);

    // Note ticket (no callvalue) + token locked via the gateway router
    assertEq(inbox.lastTo(), l2Pool);
    assertEq(inbox.lastCallValue(), 0, 'ERC20 note ticket carries no value');
    assertEq(inbox.lastMsgValue(), ARB_MSG_FEE, 'message fee forwarded');
    assertEq(gatewayRouter.lastFee(), ARB_TOKEN_FEE, 'token fee forwarded');
    assertEq(token.balanceOf(address(gatewayRouter)), 0.95 ether, 'principal locked once via gateway');
    assertEq(token.balanceOf(feeRecipient), 0.05 ether, 'relay fee paid once');
    assertEq(relayer.balance, 1 ether - ARB_MSG_FEE - ARB_TOKEN_FEE, 'relayer charged both fees');
  }

  function test_StarknetRelaySerializesNoteIntoFelts() public {
    token.mint(depositor, 10 ether);
    vm.startPrank(depositor);
    token.approve(address(tokenPool), 10 ether);
    tokenPool.deposit(10 ether, uint256(keccak256('precommit-sn')));
    vm.stopPrank();

    IPrivacyPool.Withdrawal memory _w = _buildWithdrawalChain(SN_CHAIN, 500);
    ProofLib.WithdrawProof memory _p = _buildProof(tokenPool, _w, 1 ether);
    uint256 _commitment = _p.pubSignals[1]; // C_dest

    vm.deal(relayer, 1 ether);
    vm.prank(relayer);
    tokenPool.relay{value: SN_MSG_FEE + SN_TOKEN_FEE}(_w, _p);

    // Message routed to the felt destination + handler, with the fee forwarded
    assertEq(starknetCore.lastToAddress(), SN_POOL_FELT, 'message targets the Cairo pool felt');
    assertEq(starknetCore.lastSelector(), SN_HANDLER, 'l1_handler selector carried');
    assertEq(starknetCore.lastMsgValue(), SN_MSG_FEE, 'message fee forwarded');

    // Payload = [value, commitment_low_128, commitment_high]
    uint256[] memory _payload = starknetCore.lastPayload();
    assertEq(_payload.length, 3, 'felt payload shape');
    assertEq(_payload[0], 0.95 ether, 'bridged value felt');
    assertEq(_payload[1], _commitment & type(uint128).max, 'commitment low felt');
    assertEq(_payload[2], _commitment >> 128, 'commitment high felt');
    assertEq(_payload[1] | (_payload[2] << 128), _commitment, 'felt split reconstructs the commitment');

    // Token locked via StarkGate to the felt recipient
    assertEq(starkgate.lastRecipient(), SN_POOL_FELT);
    assertEq(token.balanceOf(address(starkgate)), 0.95 ether, 'principal locked once via StarkGate');
    assertEq(relayer.balance, 1 ether - SN_MSG_FEE - SN_TOKEN_FEE, 'relayer charged both fees');
  }

  function test_RelayRevertsWhenBridgeFeeInsufficient() public {
    token.mint(depositor, 10 ether);
    vm.startPrank(depositor);
    token.approve(address(tokenPool), 10 ether);
    tokenPool.deposit(10 ether, uint256(keccak256('precommit-sn-underfund')));
    vm.stopPrank();

    IPrivacyPool.Withdrawal memory _w = _buildWithdrawalChain(SN_CHAIN, 500);
    ProofLib.WithdrawProof memory _p = _buildProof(tokenPool, _w, 1 ether);

    vm.deal(relayer, 1 ether);
    vm.prank(relayer);
    vm.expectRevert(IPrivacyPool.InsufficientBridgeFee.selector);
    tokenPool.relay{value: SN_MSG_FEE}(_w, _p); // missing the token fee
  }

  function test_RelayRefundsExcessBridgeFee() public {
    token.mint(depositor, 10 ether);
    vm.startPrank(depositor);
    token.approve(address(tokenPool), 10 ether);
    tokenPool.deposit(10 ether, uint256(keccak256('precommit-arb-refund')));
    vm.stopPrank();

    IPrivacyPool.Withdrawal memory _w = _buildWithdrawalChain(ARB_CHAIN, 500);
    ProofLib.WithdrawProof memory _p = _buildProof(tokenPool, _w, 1 ether);

    uint256 _required = ARB_MSG_FEE + ARB_TOKEN_FEE;
    vm.deal(relayer, 1 ether);
    vm.prank(relayer);
    tokenPool.relay{value: _required + 0.5 ether}(_w, _p); // overpay by 0.5

    // The 0.5 ether overpayment is refunded; relayer is charged exactly the required fees
    assertEq(relayer.balance, 1 ether - _required, 'excess bridge fee refunded to relayer');
  }

  /*//////////////////////////////////////////////////////////////
                              FEES
  //////////////////////////////////////////////////////////////*/

  function test_OnlyRegistryOwnerWithdrawsFees() public {
    token.mint(depositor, 10 ether);
    vm.startPrank(depositor);
    token.approve(address(tokenPool), 10 ether);
    tokenPool.deposit(10 ether, uint256(keccak256('precommit-wf')));
    vm.stopPrank();

    vm.prank(relayer);
    vm.expectRevert(IPrivacyPool.OnlyRegistryOwner.selector);
    tokenPool.withdrawFees(owner);

    vm.prank(owner);
    tokenPool.withdrawFees(owner);
    assertEq(token.balanceOf(owner), 0.1 ether);
    assertEq(tokenPool.accruedFees(), 0);
  }
}

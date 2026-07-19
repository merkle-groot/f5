//! End-to-end: L1 note intake -> backing/activation -> LeanIMT root -> real Groth16 withdraw.
//!
//! Forks Sepolia because the Garaga verifier calls the universal ECIP/MSM helper contracts deployed
//! there. The ERC20 is mocked (backing balance + transfers), and `scope` is `store`d to the fixed
//! value the fixture's proof `context` was bound to (the pool otherwise derives scope from its own
//! deploy address, which isn't known ahead of proof generation).

use snforge_std::cheatcodes::l1_handler::L1HandlerTrait;
use snforge_std::fs::{FileTrait, read_txt};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, mock_call, start_cheat_caller_address,
    stop_cheat_caller_address, store,
};
use starknet::ContractAddress;
use starknet_privacy_pool::interfaces::{
    IStarknetPrivacyPoolDispatcher, IStarknetPrivacyPoolDispatcherTrait,
    ITokenBridgeReceiverDispatcher, ITokenBridgeReceiverDispatcherTrait, Withdrawal,
};

// From tests/fixtures/meta.json
const L1_POOL: felt252 = 0x00000000000000000000000000000000deadbeef; // arbitrary EVM sender felt
const TOKEN_BRIDGE: felt252 = 0x888;
const SCOPE: felt252 = 12345678901234567890;
const NOTE_VALUE: felt252 = 1000000000000000000;
const NOTE_LEAF: u256 =
    7228244561325902880604135653349124518835432164549933617976242877070456665295;
const EXPECTED_ROOT: u256 =
    4746141274384843003516246808026191475835596923338180113295675049873177044782;
const NULLIFIER: u256 =
    9578174983648608475570835070685333978250405065944910425462823883177404777899;
// withdrawal
const PROCESSOOOR: felt252 = 659918; // 0xa11ce
const RECIPIENT: felt252 = 2827; // 0xb0b
const FEE_RECIPIENT: felt252 = 4078; // 0xfee
const RELAY_FEE_BPS: felt252 = 100;

fn dummy_asset() -> ContractAddress {
    0x999_felt252.try_into().unwrap()
}

fn deploy() -> (IStarknetPrivacyPoolDispatcher, ContractAddress) {
    // Real verifier (proven in the spike).
    let verifier = declare("Groth16VerifierBN254").unwrap().contract_class();
    let (verifier_addr, _) = verifier.deploy(@array![]).unwrap();

    // Pool. Constructor: (l1_pool, asset, token_bridge, withdrawal_verifier, max_relay_fee_bps:
    // u256).
    let pool = declare("StarknetPrivacyPool").unwrap().contract_class();
    let mut calldata: Array<felt252> = array![];
    calldata.append(L1_POOL);
    calldata.append(dummy_asset().into());
    calldata.append(TOKEN_BRIDGE);
    calldata.append(verifier_addr.into());
    calldata.append(1000); // max_relay_fee_bps.low
    calldata.append(0); //    max_relay_fee_bps.high
    let (pool_addr, _) = pool.deploy(@calldata).unwrap();

    // Force scope to the value the fixture proof bound its context to.
    store(pool_addr, selector!("scope"), array![SCOPE, 0].span());

    // Mock the bridged ERC20: unlimited backing balance + successful transfers.
    let big: u256 = 1000000000000000000000; // 1e21
    mock_call(dummy_asset(), selector!("balance_of"), big, 0xffffffff);
    mock_call(dummy_asset(), selector!("transfer"), true, 0xffffffff);

    (IStarknetPrivacyPoolDispatcher { contract_address: pool_addr }, pool_addr)
}

#[test]
#[fork(url: "https://api.zan.top/public/starknet-sepolia/rpc/v0_10", block_tag: latest)]
fn starkgate_callback_accepts_commitment_after_backing() {
    let (pool, pool_addr) = deploy();
    let receiver = ITokenBridgeReceiverDispatcher { contract_address: pool_addr };
    let message = array![NOTE_LEAF.low.into(), NOTE_LEAF.high.into()];

    start_cheat_caller_address(pool_addr, TOKEN_BRIDGE.try_into().unwrap());
    let accepted = receiver
        .on_receive(dummy_asset(), NOTE_VALUE.into(), L1_POOL.try_into().unwrap(), message.span());
    stop_cheat_caller_address(pool_addr);

    assert(accepted, 'callback rejected');
    assert(pool.pending_value(NOTE_LEAF) == 0, 'note did not activate');
    assert(pool.current_tree_size() == 1, 'note not inserted');
}

/// Deliver a note over the L1->L2 message path (value + commitment split lo/hi).
fn send_note(pool_addr: ContractAddress, value: felt252, commitment: u256) {
    let handler = L1HandlerTrait::new(pool_addr, selector!("receive_note"));
    let payload = array![value, commitment.low.into(), commitment.high.into()];
    handler.execute(L1_POOL, payload.span()).unwrap();
}

#[test]
#[fork(url: "https://api.zan.top/public/starknet-sepolia/rpc/v0_10", block_tag: latest)]
fn full_flow_intake_activate_withdraw() {
    let (pool, pool_addr) = deploy();

    // Intake the 4 leaves in fixture order; each activates immediately (backing is mocked large),
    // so the on-chain LeanIMT matches the fixture tree.
    send_note(pool_addr, 1, 111111111111);
    send_note(pool_addr, 1, 222222222222);
    send_note(pool_addr, 1, 333333333333);
    send_note(pool_addr, NOTE_VALUE, NOTE_LEAF);

    // On-chain tree root must equal what the circuit proved inclusion against.
    assert(pool.current_root() == EXPECTED_ROOT, 'root mismatch');
    assert(pool.current_tree_depth() == 2, 'depth mismatch');
    assert(pool.scope() == SCOPE.into(), 'scope mismatch');

    // Real Groth16 withdraw.
    let withdrawal = Withdrawal {
        processooor: PROCESSOOOR.try_into().unwrap(),
        recipient: RECIPIENT.try_into().unwrap(),
        fee_recipient: FEE_RECIPIENT.try_into().unwrap(),
        relay_fee_bps: RELAY_FEE_BPS.into(),
    };
    let file = FileTrait::new("tests/withdraw_calldata.txt");
    let calldata = read_txt(@file);

    assert(!pool.is_spent(NULLIFIER), 'already spent');
    start_cheat_caller_address(pool_addr, PROCESSOOOR.try_into().unwrap());
    pool.withdraw(withdrawal, calldata.span());
    stop_cheat_caller_address(pool_addr);

    // Note spent -> proof verified, context matched, transfers executed.
    assert(pool.is_spent(NULLIFIER), 'not spent after withdraw');
}

#[test]
#[fork(url: "https://api.zan.top/public/starknet-sepolia/rpc/v0_10", block_tag: latest)]
fn intake_rejects_wrong_l1_sender() {
    let (_, pool_addr) = deploy();
    let handler = L1HandlerTrait::new(pool_addr, selector!("receive_note"));
    let payload = array![1, 111111111111, 0];
    // from_address != L1_POOL -> the l1_handler reverts, surfaced as Err(panic_data).
    match handler.execute(0xbad, payload.span()) {
        Result::Ok(()) => panic!("intake should have rejected wrong L1 sender"),
        Result::Err(data) => assert(*data.at(0) == 'NotL1Pool', 'wrong revert reason'),
    }
}

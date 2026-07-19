use starknet::{ContractAddress, EthAddress};

/// A withdrawal request. Flattened relative to the EVM `Withdrawal` (no nested
/// `bytes`/`RelayData`):
/// on Starknet the relay fields are bound directly into the Poseidon `context`, so there is no need
/// to carry an opaque ABI blob.
#[derive(Drop, Serde, Copy)]
pub struct Withdrawal {
    /// The address permitted to submit this withdrawal (the relayer). Bound via `context`.
    pub processooor: ContractAddress,
    /// The clear recipient of the withdrawn funds.
    pub recipient: ContractAddress,
    /// The recipient of the relay fee.
    pub fee_recipient: ContractAddress,
    /// The relay fee in basis points.
    pub relay_fee_bps: u256,
}

/// Destination-side shielded pool interface.
#[starknet::interface]
pub trait IStarknetPrivacyPool<TContractState> {
    /// Activate a pending note once its bridged tokens have landed, inserting it into the tree.
    /// Permissionless. Enforces the backing invariant.
    fn activate_note(ref self: TContractState, commitment: u256);

    /// Privately spend a delivered note, exiting its full value to a clear recipient.
    /// `full_proof_with_hints` is the Garaga-format groth16 calldata for the withdrawL2 verifier.
    fn withdraw(
        ref self: TContractState, withdrawal: Withdrawal, full_proof_with_hints: Span<felt252>,
    );

    // ---- views ----
    fn current_root(self: @TContractState) -> u256;
    fn current_tree_depth(self: @TContractState) -> u32;
    fn current_tree_size(self: @TContractState) -> u32;
    fn tokens_received_from_bridge(self: @TContractState) -> u256;
    fn scope(self: @TContractState) -> u256;
    fn is_known_root(self: @TContractState, root: u256) -> bool;
    fn is_spent(self: @TContractState, nullifier_hash: u256) -> bool;
    fn pending_value(self: @TContractState, commitment: u256) -> u256;
}

/// Minimal ERC20 surface used by the pool (StarkGate delivers an L2 ERC20; even ETH is an ERC20 on
/// Starknet, so there is a single token path — no native branch).
#[starknet::interface]
pub trait IERC20<TContractState> {
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
}

/// Callback invoked by StarkGate after it has credited the bridged L2 tokens to the recipient.
#[starknet::interface]
pub trait ITokenBridgeReceiver<TContractState> {
    fn on_receive(
        ref self: TContractState,
        l2_token: ContractAddress,
        amount: u256,
        depositor: EthAddress,
        message: Span<felt252>,
    ) -> bool;
}

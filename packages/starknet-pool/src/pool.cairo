/// Starknet destination-side shielded pool: the delivery end of a Mode-3 L1->Starknet withdrawal.
///
/// Port of `L2PrivacyPool.sol`. StarkGate credits bridged tokens and then calls `on_receive` with
/// the note commitment in the same L1->L2 deposit, after which the recipient can privately spend
/// the delivered note to a clear address.
///
/// Safety rests on the same two guards as the EVM pool:
///   - Cross-domain auth: `on_receive` requires the configured StarkGate caller, L1 pool depositor,
///     and configured bridged token.
///   - Backing invariant: a note is inserted as *pending* on arrival and becomes *spendable* only
///   once
///     matching bridged tokens have landed (spendable supply can never exceed tokens received).
///
/// Differences from the EVM pool, by construction of Starknet:
///   - Single ERC20 path (StarkGate delivers an L2 ERC20; even ETH is an ERC20) — no native
///   branch.
///   - `context`/`scope` are BN254-Poseidon folds, not keccak(abi.encode(...)) — see
///   `hashing.cairo`.
///   - Commitments are `u256` (C_dest can exceed felt252), delivered split lo/hi over the wire.
#[starknet::contract]
pub mod StarknetPrivacyPool {
    use garaga::hashes::poseidon_bn254::poseidon_hash_2;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{
        ContractAddress, EthAddress, get_caller_address, get_contract_address, get_tx_info,
    };
    use crate::groth16_verifier::{
        IGroth16VerifierBN254Dispatcher, IGroth16VerifierBN254DispatcherTrait,
    };
    use crate::hashing::poseidon_fold;
    use crate::interfaces::{
        IERC20Dispatcher, IERC20DispatcherTrait, IStarknetPrivacyPool, ITokenBridgeReceiver,
        Withdrawal,
    };

    /// BN254 scalar field.
    const SNARK_SCALAR_FIELD: u256 =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    const ROOT_HISTORY_SIZE: u32 = 64;
    const MAX_TREE_DEPTH: u32 = 32;
    const BPS_DENOMINATOR: u256 = 10000;

    #[storage]
    struct Storage {
        // --- config (immutable after init) ---
        l1_pool: felt252, // L1 pool address (EVM address as a felt); the l1_handler `from_address`
        asset: ContractAddress, // the bridged L2 ERC20
        token_bridge: ContractAddress, // authorized StarkGate L2 bridge; invokes `on_receive`
        withdrawal_verifier: ContractAddress,
        max_relay_fee_bps: u256,
        scope: u256,
        // --- LeanIMT (2-input BN254 Poseidon), mirrors InternalLeanIMT ---
        side_nodes: Map<u32, u256>,
        tree_size: u32,
        tree_depth: u32,
        leaf_exists: Map<u256, bool>,
        roots: Map<u32, u256>,
        current_root_index: u32,
        // --- spend + backing ---
        nullifier_hashes: Map<u256, bool>,
        pending_value: Map<u256, u256>,
        received_commitments: Map<u256, bool>,
        activated_supply: u256,
        total_withdrawn: u256,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        NoteReceived: NoteReceived,
        NoteActivated: NoteActivated,
        Withdrawn: Withdrawn,
    }

    #[derive(Drop, starknet::Event)]
    pub struct NoteReceived {
        #[key]
        pub commitment: u256,
        pub value: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct NoteActivated {
        #[key]
        pub commitment: u256,
        pub value: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Withdrawn {
        #[key]
        pub recipient: ContractAddress,
        pub nullifier_hash: u256,
        pub value: u256,
        pub fee_amount: u256,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        l1_pool: felt252,
        asset: ContractAddress,
        token_bridge: ContractAddress,
        withdrawal_verifier: ContractAddress,
        max_relay_fee_bps: u256,
    ) {
        assert(l1_pool != 0, 'ZeroAddress');
        assert(asset.into() != 0_felt252, 'ZeroAddress');
        assert(token_bridge.into() != 0_felt252, 'ZeroAddress');
        assert(withdrawal_verifier.into() != 0_felt252, 'ZeroAddress');

        self.l1_pool.write(l1_pool);
        self.asset.write(asset);
        self.token_bridge.write(token_bridge);
        self.withdrawal_verifier.write(withdrawal_verifier);
        self.max_relay_fee_bps.write(max_relay_fee_bps);

        // scope = PoseidonBN254([pool_address, starknet_chain_id, asset]) — see hashing.cairo.
        let chain_id: u256 = get_tx_info().unbox().chain_id.into();
        self
            .scope
            .write(
                poseidon_fold(
                    array![addr_to_u256(get_contract_address()), chain_id, addr_to_u256(asset)]
                        .span(),
                ),
            );
    }

    // ---------------------------------------------------------------------
    //                          NOTE INTAKE (L1 -> L2)
    // ---------------------------------------------------------------------

    /// Receive a bridged note from the L1 pool. Invoked by the sequencer for an L1->L2 message;
    /// `from_address` is the L1 sender. Payload on the wire is `[value, commitment_lo,
    /// commitment_hi]`
    /// (three felts), so each parameter is a single-felt type reconstructed here into `u256`.
    #[l1_handler]
    fn receive_note(
        ref self: ContractState,
        from_address: felt252,
        value: felt252,
        commitment_low: felt252,
        commitment_high: felt252,
    ) {
        // Cross-domain auth: only the configured L1 pool.
        assert(from_address == self.l1_pool.read(), 'NotL1Pool');

        let commitment = u256 {
            low: commitment_low.try_into().expect('bad commitment_low'),
            high: commitment_high.try_into().expect('bad commitment_high'),
        };
        self._receive_note(value.into(), commitment);
    }

    /// StarkGate calls this only after minting/transferring the deposit into this pool.
    #[abi(embed_v0)]
    impl TokenBridgeReceiverImpl of ITokenBridgeReceiver<ContractState> {
        fn on_receive(
            ref self: ContractState,
            l2_token: ContractAddress,
            amount: u256,
            depositor: EthAddress,
            message: Span<felt252>,
        ) -> bool {
            assert(get_caller_address() == self.token_bridge.read(), 'NotTokenBridge');
            assert(depositor.into() == self.l1_pool.read(), 'NotL1Pool');
            assert(l2_token == self.asset.read(), 'WrongAsset');
            assert(message.len() == 2, 'BadMessage');

            let commitment = u256 {
                low: (*message.at(0)).try_into().expect('bad commitment_low'),
                high: (*message.at(1)).try_into().expect('bad commitment_high'),
            };
            self._receive_note(amount, commitment);
            true
        }
    }

    #[abi(embed_v0)]
    impl StarknetPrivacyPoolImpl of IStarknetPrivacyPool<ContractState> {
        fn activate_note(ref self: ContractState, commitment: u256) {
            assert(self.pending_value.read(commitment) != 0, 'NoteNotPending');
            assert(self._try_activate(commitment), 'NoteNotBacked');
        }

        // -----------------------------------------------------------------
        //                          WITHDRAWALS
        // -----------------------------------------------------------------
        fn withdraw(
            ref self: ContractState, withdrawal: Withdrawal, full_proof_with_hints: Span<felt252>,
        ) {
            // Bind the proof to a specific caller (the relayer).
            assert(get_caller_address() == withdrawal.processooor, 'InvalidProcessooor');

            // Verify the Groth16 proof; Garaga returns the public signals on success.
            let verifier = IGroth16VerifierBN254Dispatcher {
                contract_address: self.withdrawal_verifier.read(),
            };
            let pubs: Span<u256> =
                match verifier.verify_groth16_proof_bn254(full_proof_with_hints) {
                Result::Ok(p) => p,
                Result::Err(_) => panic!("InvalidProof"),
            };
            // pubs = [existingNullifierHash, noteValue, stateRoot, stateTreeDepth, context]
            assert(pubs.len() == 5, 'InvalidProof');
            let nullifier_hash = *pubs.at(0);
            let value = *pubs.at(1);
            let state_root = *pubs.at(2);
            let state_tree_depth = *pubs.at(3);
            let context = *pubs.at(4);

            // Recompute context from the request and check it matches the proof.
            assert(context == self._compute_context(withdrawal), 'ContextMismatch');
            assert(state_tree_depth <= MAX_TREE_DEPTH.into(), 'InvalidTreeDepth');
            assert(self._is_known_root(state_root), 'UnknownStateRoot');
            assert(value != 0, 'InvalidWithdrawalAmount');
            assert(
                withdrawal.relay_fee_bps <= self.max_relay_fee_bps.read(), 'RelayFeeGreaterThanMax',
            );

            // Spend the note.
            assert(!self.nullifier_hashes.read(nullifier_hash), 'NullifierAlreadySpent');
            self.nullifier_hashes.write(nullifier_hash, true);

            // Account the exit against received backing before moving funds.
            self.total_withdrawn.write(self.total_withdrawn.read() + value);

            let fee_amount = (value * withdrawal.relay_fee_bps) / BPS_DENOMINATOR;
            let amount_after_fees = value - fee_amount;

            let token = IERC20Dispatcher { contract_address: self.asset.read() };
            token.transfer(withdrawal.recipient, amount_after_fees);
            if fee_amount != 0 {
                token.transfer(withdrawal.fee_recipient, fee_amount);
            }

            self
                .emit(
                    Withdrawn {
                        recipient: withdrawal.recipient, nullifier_hash, value, fee_amount,
                    },
                );
        }

        // -----------------------------------------------------------------
        //                             VIEWS
        // -----------------------------------------------------------------
        fn current_root(self: @ContractState) -> u256 {
            self.roots.read(self.current_root_index.read())
        }
        fn current_tree_depth(self: @ContractState) -> u32 {
            self.tree_depth.read()
        }
        fn current_tree_size(self: @ContractState) -> u32 {
            self.tree_size.read()
        }
        fn tokens_received_from_bridge(self: @ContractState) -> u256 {
            self._tokens_received_from_bridge()
        }
        fn scope(self: @ContractState) -> u256 {
            self.scope.read()
        }
        fn is_known_root(self: @ContractState, root: u256) -> bool {
            self._is_known_root(root)
        }
        fn is_spent(self: @ContractState, nullifier_hash: u256) -> bool {
            self.nullifier_hashes.read(nullifier_hash)
        }
        fn pending_value(self: @ContractState, commitment: u256) -> u256 {
            self.pending_value.read(commitment)
        }
    }

    // ---------------------------------------------------------------------
    //                          INTERNAL LOGIC
    // ---------------------------------------------------------------------
    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _receive_note(ref self: ContractState, value: u256, commitment: u256) {
            assert(!self.received_commitments.read(commitment), 'NoteAlreadyReceived');
            self.received_commitments.write(commitment, true);
            self.pending_value.write(commitment, value);

            self.emit(NoteReceived { commitment, value });

            // `depositWithMessage` has already credited tokens before `on_receive`; the legacy
            // l1_handler path remains safe when its independently bridged tokens arrive first.
            self._try_activate(commitment);
        }

        /// Activate a pending note if its bridged tokens have landed. Enforces the backing
        /// invariant `activated_supply + value <= tokens_received_from_bridge`.
        fn _try_activate(ref self: ContractState, commitment: u256) -> bool {
            let value = self.pending_value.read(commitment);
            if value == 0 {
                return false;
            }
            if self.activated_supply.read() + value > self._tokens_received_from_bridge() {
                return false;
            }

            self.activated_supply.write(self.activated_supply.read() + value);
            self.pending_value.write(commitment, 0);

            self._insert(commitment);

            self.emit(NoteActivated { commitment, value });
            true
        }

        /// The total tokens received from the bridge (still held plus already withdrawn); the
        /// ceiling for spendable supply. Nothing but the bridge adds asset to this pool.
        fn _tokens_received_from_bridge(self: @ContractState) -> u256 {
            let balance = IERC20Dispatcher { contract_address: self.asset.read() }
                .balance_of(get_contract_address());
            balance + self.total_withdrawn.read()
        }

        /// Insert a leaf into the LeanIMT and record the new root. Mirrors
        /// `InternalLeanIMT._insert`.
        fn _insert(ref self: ContractState, leaf: u256) {
            assert(leaf < SNARK_SCALAR_FIELD, 'LeafGtField');
            assert(leaf != 0, 'LeafIsZero');
            assert(!self.leaf_exists.read(leaf), 'LeafExists');

            let index = self.tree_size.read();
            let mut tree_depth = self.tree_depth.read();
            if pow2(tree_depth) < (index + 1) {
                tree_depth += 1;
            }
            self.tree_depth.write(tree_depth);

            let mut node = leaf;
            let mut level: u32 = 0;
            while level < tree_depth {
                if ((index / pow2(level)) & 1) == 1 {
                    node = poseidon_hash_2(self.side_nodes.read(level), node);
                } else {
                    self.side_nodes.write(level, node);
                }
                level += 1;
            }

            let new_index = index + 1;
            self.tree_size.write(new_index);
            self.side_nodes.write(tree_depth, node);
            self.leaf_exists.write(leaf, true);

            assert(tree_depth <= MAX_TREE_DEPTH, 'InvalidTreeDepth');

            let next = (self.current_root_index.read() + 1) % ROOT_HISTORY_SIZE;
            self.roots.write(next, node);
            self.current_root_index.write(next);
        }

        /// Whether a root is in the recent history buffer.
        fn _is_known_root(self: @ContractState, root: u256) -> bool {
            if root == 0 {
                return false;
            }
            let mut index = self.current_root_index.read();
            let mut i: u32 = 0;
            let mut found = false;
            while i < ROOT_HISTORY_SIZE {
                if root == self.roots.read(index) {
                    found = true;
                    break;
                }
                index = (index + ROOT_HISTORY_SIZE - 1) % ROOT_HISTORY_SIZE;
                i += 1;
            }
            found
        }

        /// context = PoseidonBN254([processooor, recipient, fee_recipient, relay_fee_bps, scope]).
        fn _compute_context(self: @ContractState, w: Withdrawal) -> u256 {
            poseidon_fold(
                array![
                    addr_to_u256(w.processooor), addr_to_u256(w.recipient),
                    addr_to_u256(w.fee_recipient), w.relay_fee_bps, self.scope.read(),
                ]
                    .span(),
            )
        }
    }

    /// ContractAddress -> u256 (via felt252). Starknet addresses are < 2^251 < BN254 field.
    fn addr_to_u256(a: ContractAddress) -> u256 {
        let f: felt252 = a.into();
        f.into()
    }

    /// 2^n for the LeanIMT level math (n stays small: <= MAX_TREE_DEPTH).
    fn pow2(n: u32) -> u32 {
        let mut r: u32 = 1;
        let mut i: u32 = 0;
        while i < n {
            r *= 2;
            i += 1;
        }
        r
    }
}

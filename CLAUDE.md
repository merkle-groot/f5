# Cutout — Architecture Spec
---

## 1. System

A single Privacy Pool on Ethereum L1. Deposits are destination-agnostic — destination is a property of the withdrawal, so routing to N chains concentrates one anonymity set rather than fragmenting deposits across chains.

Every withdrawal is Mode 3: spend an L1 note, canonically bridge its value to a destination L2 shielded pool, and deliver a stealth commitment into that pool. No public address ever touches the value on either side.

- One deposit flow, one withdrawal circuit, one nullifier set, one ASP compliance check.
- No destination selector — there is exactly one output shape.
- Off-chain relayer model: proofs are generated client-side and submitted to L1 by a relayer; the relayer address and fee are bound as public inputs to the circuit.

**Primitives:** Poseidon hash, Baby Jubjub curve (stealth derivation + destination commitment), Groth16 verification, fixed-depth Merkle tree with zero-subtree padding (Tornado `MerkleTreeWithHistory` reference — **not** LeanIMT; the free `actualDepth` witness permits truncation).

**Value privacy:** out of scope. Amounts are forwarded in plaintext. Conservation is one in-circuit equality per withdrawal; there is no aggregate sum, no range proof, no wraparound vector. Consequence: with variable denominations, **amount is the dominant residual leak** — unlinkability is bounded to the set of same-amount deposits. Accepted.

---

## 2. Keys and addresses

**Recipient shielded address**, published once, both keypairs on Baby Jubjub:
- spend key `(b, B)`, `B = b·G`
- view key `(v, V)`, `V = v·G`

The address is the pair `(B, V)` — a 5564-*shaped* Baby Jubjub meta-address. It is **not** an EIP-5564 stealth meta-address in the conformant sense (different curve, different hash, no Announcer, no address in the value path). Never document it without that curve caveat.

**L1 note (Privacy Pools form):**
- `precommitment = Poseidon(nullifier, secret)`
- `label` associates the deposit for ASP compliance
- `C_src = Poseidon(value, label, precommitment)`
- `nullifierHash = Poseidon(nullifier)`

---

## 3. Deposit (L1)

User deposits `value` of a supported token into the L1 pool. `C_src` is inserted into the fixed-depth tree; the tree root enters the rolling history buffer. Deposit reveals nothing about future destination.

---

## 4. Sender note construction (stealth, off-chain)

For a withdrawal to recipient `(B, V)`:

1. ephemeral scalar `e`, `E = e·G`
2. shared secret `ss = e·V` (recipient recomputes `v·E`)
3. one-time owner key `P = B + Poseidon(ss)·G`
4. blinding `r = Poseidon(ss, 1)`
5. destination commitment `C_dest = Poseidon(value, P, r)`
6. view tag `= first byte of Poseidon(ss)` (cheap scan pre-filter)

Because amounts are plaintext, the only secret that must reach the recipient is `E` (plus the view tag). The encrypted-note blob collapses to essentially the ephemeral pubkey.

---

## 5. Withdrawal circuit

One branch, always active. There is no mode selector to constrain.

**Public inputs:** L1 root, `nullifierHash`, ASP root, bridged `value`, `C_dest`, `E`, destination `chainId`, `l2Pool` address, relayer address, fee.

**Private witnesses:** L1 note preimage (`value`, `nullifier`, `secret`, `label`), Merkle inclusion path, ASP association path, `P`, `r`.

**Constraints:**
1. **L1 inclusion** — `C_src` is in the tree under a public historical root.
2. **Nullifier** — `nullifierHash = Poseidon(nullifier)`, correctly derived from the note.
3. **Spend authorization** — prover knows `(nullifier, secret)`.
4. **ASP association** — `label` is in the approved association set (portable L1 compliance boundary; checked once, inherited).
5. **Conservation** — bridged `value == ` the spent note's committed value. Single output, no aggregate.
6. **Value binding (the critical line)** — the value field inside `C_dest` equals the public bridged `value`. Without this a prover mints unbacked L2 supply.
7. **Anti-theft binding** — relayer address, fee, `chainId`, `l2Pool` are bound as public inputs; a stolen proof cannot be re-targeted or re-priced.

`P` and `r` remain opaque witnesses. A botched stealth derivation only griefs the sender — it never threatens pool soundness — so nothing about the stealth math needs to be constrained beyond the value field.

---

## 6. Canonical transport — two ops that must reconcile

On proof acceptance, the L1 pool burns the note (`nullifierHash` marked spent) and emits two independent operations across the canonical messenger:

1. `bridgeERC20To(l2Pool, value)` — moves the tokens.
2. `sendMessage(l2Pool, receiveShieldedNote(C_dest, value, E))` — carries the note. `value` rides in cleartext because the pool cannot read it from the hash.

They arrive in separate transactions with **no ordering guarantee**. The L2 pool enforces, entirely on-chain:

- **Cross-domain auth** — the note must be provably from `L1Pool`, or anyone mints backed claims. The *proof* is bridge-family-specific: OP-Stack checks `xDomainMessageSender == L1Pool` via the L2 messenger; **Arbitrum** has no messenger, so the note arrives as a direct call whose `msg.sender` is the L1 pool's *aliased* address and the L2 pool checks `undoL1ToL2Alias(msg.sender) == L1Pool`.
- **Backing invariant** — `spendableShieldedSupply ≤ tokensReceivedFromBridge`. A note is inserted as *pending* and becomes *spendable* only once matching bridged tokens have landed. This is what makes the unordered two-op split safe.
- **Finality gate** — free. OP-Stack deposits derive from finalized L1 state, giving reorg safety across the whole path.

The two ops above are the **OP-Stack** shape. The L1 pool's `_bridge` dispatches on a per-destination `BridgeKind` across three canonical families — **OP-Stack** (messenger + standard bridge), **Arbitrum** (Delayed Inbox retryable tickets + L1 Gateway Router; native ETH collapses to a *single* retryable carrying value as `l2CallValue`, so it delivers one op, not two), and **Starknet** (Starknet Core + StarkGate). Arbitrum/Starknet prepay the L1→L2 fee up front, fronted by the relayer as `msg.value`. See `packages/contracts/BRIDGE_TARGETS.md` for the full per-family breakdown.

---

## 7. Cross-chain nullifiers

No shared nullifier set is required. `C_src` dies on L1 at spend; `C_dest` is a fresh note that could not exist before value physically crossed. Double-spend-across-chains is structurally impossible — this is precisely why per-hop burn-and-mint is buildable today, while the *unified cross-chain note* (reconciled nullifier sets across chains) remains open (§11).

---

## 8. Recipient spend (L2)

Recipient scans L2 pool insertions with the view key: view-tag byte filters cheaply, then `v·E` confirms `ss` and recomputes `P`. To spend, derive `b + Poseidon(ss)` and open the Poseidon ownership constraint inside the L2 circuit — a witness, never an Ethereum signature. This is why Baby Jubjub is forced and secp256k1 is not: the spend key authorizes a commitment opening in-circuit, it does not sign a transaction.

From there it is an ordinary L2 pool spend: exit to a clear address, re-shield, or Mode 3 onward to another chain (recursive).

---

## 9. Self-bridge

Self-bridge (moving your own funds to spend privately on L2) is a strict special case of the third-party send, not a separate path. ECDH is redundant (you hold `v`), scanning is skipped (you cache/re-derive your own notes), no counterparty key provisioning.

**Ruling:** even though `E`/view-tag are redundant for self-authored notes, the on-chain footprint **must remain byte-identical** to a third-party send. Emitting a distinguishable "self" shape would create observable sub-buckets that fragment the anonymity set. The divergence lives only in the wallet.

---

## 10. What removing Modes 1/2/2.5 changes

- **No destination selector.** One output shape; the mutual-exclusion witnesses (mode-2 address vs mode-3 `C_dest`) and exclusive-selector invariant are deleted. The circuit is smaller and has one fewer class of soundness bug.
- **Value binding is unconditional.** Previously gated on the selector; now always on.
- **No L2 announcer.** Mode 2.5's stealth-EOA path needed a 5564-style announcer to publish `E` on L2. Mode 3 carries `E` in the note message, so no announcer component exists.
- **Cannibalization dissolves.** The cheap paths (1, 2, 2.5) padded no L2 shielded set and siphoned exactly the users who would otherwise provide cover. With only Mode 3, **every withdrawal pads the shielded set by construction.** The "make Mode 3 the default or the pool is decorative" tension is gone — there is nothing else to default to.
- **Two things become mandatory, not optional** (see §12):
  - **Scanning infrastructure + published shielded addresses.** Self-bridge-only could have shipped without these; Mode 3 cannot. Third-party send *is* the primitive, and it requires the recipient to have published `(B, V)` and to be able to scan.
  - **Gas delivery on destination.** Every recipient lands with a shielded note and zero native L2 gas. This can no longer be punted — there is no clear-EOA fallback.

---

## 11. Security posture

- **Canonical-only bridging.** No third-party bridge trust surface — a live differentiator against 2026's third-party-bridge exploit record. Any intent/solver fast-path reintroduces that surface and stays opt-in, never default.
- **Portable L1 compliance.** ASP association checked once at L1, inherited by the delivered L2 note. Institutional wedge; no standing committee, no subpoenable quorum, no permanent ciphertexts enabling retroactive de-anonymization.
- **Fixed-depth tree.** Zero-subtree padding; LeanIMT's truncation vector is excluded by construction.

---

## 12. Open items

1. **Unified cross-chain note** — a note in the L2-A shielded pool spendable on L2-B without pre-committing a destination. Requires reconciled nullifier sets across chains. L1-as-single-nullifier-oracle is the sound design but pays the L2→L1 slow leg (a week on optimistic rollups). Highest-leverage research question; the item that would make Cutout unambiguously not a wrapper.
2. **Gas delivery on destination** — recipient lands with a shielded note and no native gas. Options: relayer reimbursed from the note value, or a bundled native-gas drop. Now blocking, not optional. *(Distinct and separate: the L1→L2 **messaging/execution** fee for Arbitrum/Starknet is handled — the relayer fronts it as `msg.value` and prices it into its quote. That delivers the note; it does not give the recipient native gas to initiate their own L2 spend, which is what this item is about. The L2 spend itself is relayer-submitted, fee deducted from the note.)*
3. **Scanning throughput** — view-tag pre-filter is the cheap path; needs an indexer/light-scan story for recipients who don't run full infrastructure.
4. **Committee-free amount privacy** — incremental/recursive folding where each user folds their own hidden value and only the per-chain sum is revealed. v2, only if amount privacy becomes non-negotiable.
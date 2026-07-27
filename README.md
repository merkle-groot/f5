# f5: Cross-Chain Private Withdrawals over a Single L1 Privacy Pool

f5 is a single Privacy Pool on Ethereum L1 whose **only** withdrawal path is a private,
cross-chain delivery: spend an L1 note, canonically bridge its value to a destination L2 shielded
pool, and deliver a **stealth commitment** into that pool. No public address ever touches the value
on either side.

Deposits are **destination-agnostic**: the destination is a property of the withdrawal, not the
deposit. Routing to N chains therefore concentrates one anonymity set instead of fragmenting
deposits across N pools.

> **Status: testnet.** Sepolia L1 with OP Sepolia / Base Sepolia / Arbitrum Sepolia destinations.
> Starknet is implemented but currently **disabled by a fail-closed gate**. See
> [Status and known gaps](#status-and-known-gaps). This is not production software and has not been
> audited.

![The f5 shielded vault: a transit map of L1 and the four destination chains, alongside the spendable
balance, per-chain note counts, and the published Baby Jubjub shielded address.](./assets/vault-transit-map.png)

The reference wallet presents the pool as a transit map, where chains are stations and the pool is
the interchange. Each route carries the notes this vault owns on that chain, and the shielded address
panel is the `(B, V)` pair a sender resolves to pay you. Spending and viewing keys, the recovery
phrase, and every note secret stay in the browser.

---

## Table of contents

- [How it works](#how-it-works)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Bridge families](#bridge-families)
- [Identity and key derivation](#identity-and-key-derivation)
- [Deployments](#deployments)
- [Testing and verification](#testing-and-verification)
- [Emergency ragequit](#emergency-ragequit)
- [Security posture](#security-posture)
- [Status and known gaps](#status-and-known-gaps)

---

## How it works

There is exactly one deposit flow, one withdrawal circuit, one nullifier set and one ASP compliance
check. There is no destination selector, because there is only one output shape.

### 1. Deposit (L1)

A user deposits `value` of a supported asset into the L1 pool.

```
precommitment = Poseidon(nullifier, secret)
C_src         = Poseidon(value, label, precommitment)
nullifierHash = Poseidon(nullifier)
```

A vetting fee is deducted first, so the committed `value` is the net amount. `C_src` is inserted into
a **LeanIMT** state tree (`InternalLeanIMT`, proven in-circuit by `LeanIMTInclusionProof(32)`), whose
depth is bounded by `MAX_TREE_DEPTH = 32` at insertion and again when a proof is verified. The new
root enters a 64-slot circular history buffer (`ROOT_HISTORY_SIZE`). The deposit reveals nothing
about any future destination.

### 2. Sender note construction (off-chain, stealth)

The recipient publishes a shielded address `(B, V)`: a spend key `B = b·G` and a view key
`V = v·G`, both on **Baby Jubjub**. To send to `(B, V)`:

```
e   ← random scalar          E  = e·G            (ephemeral pubkey)
ss  = e·V                    (recipient recomputes v·E)
P   = B + Poseidon(ss)·G     (one-time owner key)
r   = Poseidon(ss, 1)        (blinding)
C_dest   = Poseidon(P.x, P.y, value, r)          (4-input; P enters as coordinates)
view tag = Poseidon(ss) mod 256                  (low byte; cheap scan pre-filter)
```

Because amounts travel in plaintext, the only secret that must reach the recipient is `E` plus the
view tag. The "encrypted note blob" collapses to essentially the ephemeral pubkey. Both travel in the
L1 `L2Note` event, **not** in the bridge message — see [step 4](#4-canonical-transport-one-or-two-ops-depending-on-the-family).

> **Curve caveat:** `(B, V)` is a 5564-*shaped* meta-address, **not** a conformant EIP-5564 stealth
> meta-address: different curve, different hash, no Announcer, and `P` is never an Ethereum
> address. It is published to the ERC-6538 registry under a domain-separated `schemeId` (**never 1**)
> precisely so conformant secp256k1 tooling ignores it, instead of reading the blob as secp256k1
> keys, deriving a garbage address, and sending real funds there.

### 3. Withdrawal proof (`withdrawL1`)

One branch, always active. **Withdrawals are partial**: a spend splits the note three ways rather
than consuming it.

**Public signals — ten, ordered by the circuit's declaration order** (outputs first, then inputs —
*not* the order in `component main {public [...]}`):

| idx | signal | | idx | signal |
|---|---|---|---|---|
| 0 | `newCommitmentHashL1` — the L1 change note | | 5 | `stateRoot` |
| 1 | `newCommitmentHashL2` — `C_dest` | | 6 | `stateTreeDepth` |
| 2 | `existingNullifierHash` | | 7 | `ASPRoot` |
| 3 | `withdrawnValue` — gross amount spent | | 8 | `ASPTreeDepth` |
| 4 | `bridgedValue` — net delivered to L2 | | 9 | `context` |

`E`, the view tag, `chainId`, `l2Pool`, the fee recipient and `relayFeeBPS` are **not** public
inputs. They are bound transitively through
`context = keccak256(abi.encode(Withdrawal{chainId, data}, SCOPE)) % p`, which `relay()` recomputes
and rejects on mismatch (`ContextMismatch`).

**Private witnesses:** the note preimage (`existingValue`, `existingNullifier`, `existingSecret`,
`label`), the change-note secrets (`newNullifier`, `newSecret`), the recipient's spend key `B`, the
shared secret `ss`, and both Merkle paths. `P` and `r` are *derived* in-circuit from `B` and `ss`
rather than supplied.

**Constraints:**

| # | Constraint | Why |
|---|---|---|
| 1 | L1 inclusion: `C_src` under a public historical root | the note exists |
| 2 | `existingNullifierHash = Poseidon(nullifier)`, derived from the same preimage | no double spend |
| 3 | Spend authorization — implicit in 1–2: only the holder of `(nullifier, secret)` can open the commitment | only the owner spends |
| 4 | ASP association: `label` is in the approved set | portable L1 compliance, checked once |
| 5 | **Conservation, three ways**: `remainingValue = existingValue − withdrawnValue` (128-bit range-checked, the underflow guard) becomes the L1 change note; `bridgedValue ≤ withdrawnValue`, the gap being the relay fee | two outputs, not one — and the contract pins the fee exactly (`BridgedValueMismatch`) |
| 6 | Change-note freshness: `newNullifier ≠ existingNullifier` | a change note cannot reuse the burnt nullifier |
| 7 | **Value binding**: `C_dest` is hashed over `bridgedValue` | without it, a prover mints unbacked L2 supply |
| 8 | Anti-theft binding via `context`: `chainId`, `l2Pool`, fee recipient, `relayFeeBPS` | a stolen proof cannot be re-targeted or re-priced |

A botched stealth derivation only griefs the sender and can never threaten pool soundness, so nothing
about the stealth math is constrained beyond the value field.

Proofs are generated **client-side** (in a Web Worker, `app/src/prover.worker.js`) and submitted to
L1 by a relayer.

### 4. Canonical transport: one or two ops, depending on the family

On proof acceptance the L1 pool burns the note (`nullifierHash` marked spent) and hands value + note
to the **canonical** bridge. How many operations that takes is family-specific, and **only OP-Stack
takes two** — see [Bridge families](#bridge-families). The two-op case is described here because it
is the hard one; the single-op families are a strict simplification of it.

On OP-Stack, two independent operations across the canonical messenger:

1. `bridgeERC20To(l2Pool, value)` moves the tokens.
2. `sendMessage(l2Pool, IL2Pool.deposit(value, commitmentHash))` carries the note. `value` rides in
   cleartext because the pool cannot read it out of the hash.

The message carries **only** `(value, C_dest)`. `E` and the view tag are not in it — the destination
pool has no use for them. They are emitted on L1 as `L2Note(C_dest, ephemeralKey, viewTag)`, which is
where recipients scan for them.

They arrive in **separate transactions with no ordering guarantee**. The L2 pool enforces, entirely
on-chain:

- **Cross-domain auth.** The note must provably originate from `L1Pool`, or anyone mints backed
  claims. The proof is bridge-family-specific (see [below](#bridge-families)).
- **Backing invariant.** `spendableShieldedSupply ≤ tokensReceivedFromBridge`. A note is inserted
  as *pending* and becomes *spendable* only once matching bridged tokens have landed. This is what
  makes the unordered two-op split safe.
- **Finality gate.** Free on OP-Stack: deposits derive from finalized L1 state, giving reorg safety
  across the whole path.

Where delivery is a **single** op — every Starknet note, and native Arbitrum ones — none of the
reconciliation above is needed. The tokens are already credited when the note handler runs, so the
backing check passes inline and the note is inserted and spendable in the **same transaction**
(`NoteReceived` and `NoteActivated` emit together). There is nothing to scan for and no second
transaction to send.

### 5. Recipient spend (L2)

Scanning is a **two-chain join**. The stealth material and the value are emitted on different chains
and the recipient needs both halves: `(E, viewTag)` from the L1 `L2Note` event, joined on `C_dest`
with the cleartext `value`, which only exists once the tokens land on the destination
(`buildScannableNotes` in `app/server/pool-events.mjs`). A delivery with no matching arrival is
dropped — the bridge has not settled yet.

Given the join, the view-tag byte filters cheaply, then `v·E` confirms `ss` and recomputes `P`. To
spend, they derive `b + Poseidon(ss)` and open the Poseidon ownership constraint **inside** the L2
circuit. It is a witness, never an Ethereum signature.

This is why Baby Jubjub is forced and secp256k1 is not: the spend key authorizes a commitment
opening in-circuit; it does not sign a transaction.

From there it is an ordinary L2 pool spend: exit to a clear address, re-shield, or go onward to
another chain (recursive).

### Cross-chain nullifiers

No shared nullifier set is required. `C_src` dies on L1 at spend; `C_dest` is a fresh note that could
not have existed before value physically crossed. Double-spend-across-chains is structurally
impossible, which is exactly why per-hop burn-and-mint is buildable today while the *unified
cross-chain note* remains an open research item.

### Self-bridge

Moving your own funds to spend privately on L2 is a strict special case of the third-party send, not
a separate path. ECDH is redundant (you hold `v`), scanning is skipped, and there is no counterparty
key provisioning. But the on-chain footprint is **byte-identical** to a third-party send. Emitting a
distinguishable "self" shape would create observable sub-buckets that fragment the anonymity set. The
divergence lives only in the wallet.

### What is explicitly out of scope

**Value privacy.** Amounts are forwarded in plaintext and every withdrawal publishes `withdrawnValue`.
Conservation is enforced by in-circuit range checks and an ordering constraint; there is no blinded
aggregate, no range proof over a hidden sum, no wraparound vector. **The amount is the dominant
residual leak** — though weaker than a same-denomination bound: because withdrawals are partial and
the change note's value is never emitted (only its commitment hash), a published `withdrawnValue = W`
is consistent with spending *any* unspent note of value **≥ W**. The candidate set is
`{unspent notes ≥ W}`, not `{notes = W}`. This is an accepted trade-off, not an oversight.

---

## Repository layout

A Yarn workspaces monorepo. `app/` is deliberately **not** a workspace. It reuses the repository's
existing `node_modules` during development, so installing the core packages does not require
resolving a second dependency graph.

```
packages/
  circuits/        Circom circuits + Groth16 setup / proving scripts
  contracts/       Solidity: L1 pool, Entrypoint, L2 pools, verifiers, bridge dispatch
  starknet-pool/   Cairo destination-side shielded pool (Starknet analog of L2PrivacyPool)
  sdk/             TypeScript toolkit: proving, notes, scanning, relay calls
  relayer/         Express + SQLite relayer: fee quotes, proof submission
app/               Reference UI (Vite client) + API boundary (Node server)
assets/            README images
ops/               Deployment sanity-check scripts
```

### Key source files

| Path | What it is |
|---|---|
| `packages/circuits/circuits/withdrawL1.circom` | the one withdrawal circuit (L1 spend → bridged note) |
| `packages/circuits/circuits/withdrawL2.circom` | destination-side spend |
| `packages/circuits/circuits/commitmentL2Sender.circom` | sender-side commitment construction |
| `packages/contracts/src/contracts/PrivacyPool.sol` | L1 pool; `relay()` and the `_bridge` dispatch |
| `packages/contracts/src/contracts/Entrypoint.sol` | upgradeable entry/registry (the pool itself is *not* proxied) |
| `packages/contracts/src/contracts/L2/L2PrivacyPool.sol` | OP-Stack destination pool |
| `packages/contracts/src/contracts/L2/L2PrivacyPoolArbitrum.sol` | same pool, address-aliasing auth |
| `packages/contracts/src/contracts/lib/ProofLib.sol` | public-signal accessors (see the warning below) |
| `packages/starknet-pool/src/pool.cairo` | `StarknetPrivacyPool`: StarkGate intake, LeanIMT, Garaga verify |
| `app/server/routes/{l1,l2,starknet,misc}.mjs` | app API: deposits, indexing, calldata, config gates |

> ⚠️ **Never hand-derive `withdrawL1` public-signal indices.** Circom numbers public signals by the
> *template's declaration order* (outputs first, then inputs), **not** by the order listed in
> `component main {public [...]}`. Getting this wrong once silently bricked every relay in three
> layers at once, and the old test compared the three hand-written copies *against each other*, so
> the suite passed. `packages/sdk/test/unit/withdrawalSignals.spec.ts` now reconciles four
> independently produced sources (generated verifier `nPublic`, the circuit `.sym`, `ProofLib.sol`,
> the SDK map), so a circuit change fails the build instead. Read the authoritative order out of
> `packages/circuits/build/withdrawL1/withdrawL1.sym`, never off a hand-written table.

---

## Quick start

### Prerequisites

- Node.js and Yarn (Yarn workspaces)
- [Foundry](https://book.getfoundry.sh/) for contracts
- [`circom`](https://github.com/iden3/circom/releases/tag/v2.2.1) **v2.2.1** + `snarkjs` for
  circuit work. Install the released binary; CI pins the same version
  (`.github/workflows/circuits.yml`). Do not vendor the compiler source into this repo.
- `scarb` 2.16.1 / `starknet-foundry` 0.57.0 for the Cairo pool (pinned in
  `packages/starknet-pool/.tool-versions`)

### Install

```bash
yarn
```

### Run the reference app

```bash
cp app/.env.example app/.env
yarn --cwd app dev
```

The Vite client runs on `5173`; the API on `8787`. The `dev` script starts both with a small Node
runner, so no global `concurrently` is needed. Vite hot-reloads the client; **restart the API
manually after server changes.**

Set `PUBLIC_RPC_URL`, `POOL_ADDRESS` and `DEPLOYMENT_BLOCK` for SDK-backed pool activity and user
deposits; the `L2_*` values for note indexing, bridge status and reconstructed L2 Merkle proofs; and
`RELAYER_API_URL` to proxy the real relayer. For the recorded Sepolia deployment, start from
`app/.env.sepolia.example`.

The browser generates the commitment preimage and sends the deposit from the connected wallet, so
the relayer never receives the note secret. The UI is split into **DEPOSIT / SEND / RECEIVE** so a
sender can never hold the recipient's private keys.

### Run the production relayer

```bash
cp packages/relayer/config.sepolia.example.json /private/path/config.sepolia.json
# fill in the deployed Entrypoint, fee receiver, and relayer key
CONFIG_PATH=/private/path/config.sepolia.json PORT=8788 \
  yarn workspace @f5/relayer build:start
```

The app proxies `/api/relayer/quote` and `/api/relayer/request` to it. The app's own `/api/relay`
route is an SDK-backed fallback and **must never be exposed without a server-side relayer key**.

### Common commands

```bash
# circuits
yarn workspace @f5/circuits compile
yarn workspace @f5/circuits setup:all      # ptau + zkeys
yarn workspace @f5/circuits test

# contracts
yarn workspace @f5/contracts build
yarn workspace @f5/contracts test:unit
yarn workspace @f5/contracts test:integration

# sdk / relayer
yarn workspace @f5/privacy-pool-sdk test
yarn workspace @f5/relayer test

# app
yarn --cwd app test:server
yarn --cwd app build

# deployment sanity check
yarn check:deployment            # add --onchain to hit RPCs
```

---

## Bridge families

The bridge is **inlined into `PrivacyPool`**, with no adapter contract in the value path. `_bridge`
dispatches on a `BridgeKind` discriminator stored in a per-`(chain, token)` `BridgeConfig`. Adding a
destination chain is a Registry config row; adding a destination *family* is one new code path.

| | **OP-Stack** (Optimism, Base) | **Arbitrum** (One / Nova) | **Starknet** |
|---|---|---|---|
| Note message | `L1CrossDomainMessenger.sendMessage` | Inbox `createRetryableTicket` | inside `depositWithMessage` |
| Token lock | `L1StandardBridge.bridge{ERC20,ETH}To` | Gateway Router `outboundTransferCustomRefund` | StarkGate `depositWithMessage` |
| Destination id | 20-byte `l2Pool` | 20-byte `l2Pool` | `l2PoolFelt` (felt252) |
| L1→L2 fee | none (L1-derived gas) | `submissionCost + gasLimit·maxFeePerGas`, per op | one flat StarkGate fee |
| Native value | `bridgeETHTo{value}` | rides as retryable `l2CallValue` (**single** ticket) | rides in `depositWithMessage{value}` |
| Auth on L2 | `xDomainMessageSender == L1Pool` | `undoL1ToL2Alias(msg.sender) == L1Pool` | `l1_pool` immutable, set in the constructor |
| Code path | `_bridgeOpStack` | `_bridgeArbitrum` | `_bridgeStarknet` |

Arbitrum has no L2 messenger, so the note arrives as a direct call whose `msg.sender` is the L1
pool's *aliased* address, hence the `AddressAliasHelper` check.

**Op count per family** — this is what decides whether activation is a separate step:

| Family | L1 ops | Activation |
|---|---|---|
| OP-Stack | 2 (always) | separate transaction, after the backing lands |
| Arbitrum | **1** native / 2 ERC20 | inline for native (`l2CallValue` is credited with the ticket); separate for ERC20 |
| Starknet | **1** (always) | **inline, always** |

Arbitrum **native ETH collapses to a single retryable** carrying value as `l2CallValue`, so it
delivers one op, not two. **Starknet is single-op in every case**: `depositWithMessage` carries the
commitment as its message payload, and StarkGate credits the tokens *before* invoking the pool's
authenticated `on_receive`, which activates the note in the same call. `activate_note` on the Cairo
pool is therefore unreachable on Starknet today: the only path that could leave a note pending is the
superseded `#[l1_handler] receive_note` entrypoint, and no L1 code sends the raw Starknet Core message
that would invoke it.

**Fee model.** `relay` is `payable`. Arbitrum and Starknet charge for L1→L2 execution up front, so
the **relayer prepays it as `msg.value`** and the pool refunds the excess (`msg.value − feeSpent`).
Each such path checks `msg.value ≥ requiredFee` and reverts `InsufficientBridgeFee` otherwise. The
pool **never** uses its own principal to pay L1→L2 fees, which specifically matters for native pools
whose ETH balance would otherwise be raided for gas. The relayer is reimbursed through the relay fee
it already collects, and the SDK must forward this `msg.value` for Arbitrum/Starknet destinations.
Note this is the *messaging* fee; it is distinct from the still-open problem of giving the recipient
native gas on the destination.

The `BridgeConfig` struct is a flat union spanning all three families, tagged by `kind`, with fields
unused by a given kind left zero and documented per field in `IEntrypoint.sol`.

---

## Identity and key derivation

**One twelve-word mnemonic is the root of the entire identity**, and it is the only thing a user
backs up.

| Derived material | HD account |
|---|---|
| `masterNullifier`, `masterSecret` (L1 note secrets) | 0, 1 |
| `b`, `v` (shielded spend + view keys) | 2, 3 |
| local vault encryption key | 4 |

**Nothing is derived from a wallet signature.** Signatures are only deterministic for RFC-6979
signers, and plenty of smart-contract wallets and WalletConnect implementations are not. A
signature that came back different once would mean keys that can never be re-derived. A wallet (or a
password) may *unwrap* the stored mnemonic, but it is never the source of a key, so a wallet change
or a non-deterministic signer is recoverable rather than fatal. The password path also lets a pure
recipient use RECEIVE with **no EOA connected at all**, which is the whole point of a stealth
address.

**The note vault is a cache, not the source of truth.** Deposit secrets are
`Poseidon(master, scope, index)`, so `recoverNotes()` rebuilds every L1 note from the mnemonic plus
public `Deposited` events. Losing `localStorage` is survivable. Deposit indices come from chain
state, not a local counter. Two devices sharing a mnemonic would otherwise derive the same
precommitment, and the second deposit would revert `PrecommitmentAlreadyUsed`.

Notes written before the mnemonic scheme existed used pure local entropy and are **not**
re-derivable; both legacy vault messages are tried on unlock and those notes are migrated into the
new vault.

---

## Deployments

Recorded addresses live in `packages/contracts/deployments/<chainId>.json`.

| Chain | ID | Role |
|---|---|---|
| Sepolia | 11155111 | L1 pool, Entrypoint, verifiers |
| OP Sepolia | 11155420 | `L2PrivacyPool` destination |
| Base Sepolia | 84532 | `L2PrivacyPool` destination |
| Arbitrum Sepolia | 421614 | `L2PrivacyPoolArbitrum` destination |

Deploy and configure scripts are Foundry scripts under `packages/contracts/script`, wired to yarn
scripts (`deploy:l2:*`, `configure:bridge:*`, `update:l1:root:sepolia`, `bridge:funds:op-sepolia`, …).
Run `yarn check:deployment --onchain` to verify a deployment against live RPCs.

---

## Testing and verification

Beyond unit tests, several invariants are pinned by tests that read **both sides from source**
rather than comparing hand-written copies to each other:

- **Public-signal layout.** `withdrawalSignals.spec.ts` reconciles the generated verifier, the
  circuit `.sym`, `ProofLib.sol` and the SDK map.
- **Indexer event ABIs.** `eventAbis.spec.ts` reads the Solidity interface *and* the indexer's own
  `parseAbiItem` strings, asserting names, order and `topic0` all agree. Two real drifts were caught
  this way, both silent: `Deposited` decoded correctly *by accident* (types matched, one field was
  misnamed, and a well-meaning rename would have made notes unrecoverable), and `Withdrawn` kept a
  stale pre-Mode-3 shape, so `topic0` differed, `getWithdrawals()` matched nothing and returned `[]`
  forever, and spent notes looked unspent.
- **Poseidon parity.** The Cairo pool asserts Garaga's Poseidon reproduces the circomlib LeanIMT
  root.
- **Starknet full flow.** A fork test runs StarkGate intake → backing/activation → on-chain root
  equals the circuit's `stateRoot` → a **real Groth16 `withdraw`**, plus a negative test that intake
  rejects a wrong L1 sender.
- **Live-chain decode validation.** 713 real Sepolia `Deposited` logs all satisfy
  `Poseidon(value, label, precommitment) === commitment`.

Also exercised end to end: a third-party send round-trip (a note built from only `(B, V)` is found by
a recipient scanning with `(b, v)`; decoys and strangers match nothing), and the full identity
lifecycle (generate phrase → deposit at chain-derived indices → **wipe local storage** → recover every
note from the phrase alone → publish to the registry → a sender who only ever sees the registry blob
pays it → the recipient scans and finds it).

---

## Emergency ragequit

Ragequit is the L1 pool's emergency exit for a depositor whose note cannot use the normal
ASP-approved withdrawal path. **It is not a private withdrawal:** the transaction publicly links the
original deposit address, the commitment, and the amount returned.

Only the EOA that originally deposited the note may call `ragequit`, and that same address must pay
the L1 gas. A relayer cannot submit it because the pool checks `msg.sender` against the depositor
recorded for the note's label. A successful ragequit is irreversible and burns the note's nullifier.
It remains available after the pool is wound down, so depositors retain an exit of last resort.

---

## Security posture

- **Canonical-only bridging.** No third-party bridge trust surface. Any intent/solver fast-path
  reintroduces that surface and stays opt-in, never default.
- **Portable L1 compliance.** ASP association is checked once at L1 and inherited by the delivered L2
  note. No standing committee, no subpoenable quorum, no permanent ciphertexts enabling retroactive
  de-anonymization.
- **Bounded-depth LeanIMT.** The L1 state tree is a LeanIMT, not a fixed-depth zero-padded tree.
  Depth is bounded twice on-chain — `State._insert` reverts `MaxTreeDepthReached` past
  `MAX_TREE_DEPTH = 32`, and `relay()` rejects a proof declaring a larger `stateTreeDepth` /
  `ASPTreeDepth` (`InvalidTreeDepth`). In-circuit, `actualDepth` is constrained only by
  `LessEqThan(6)` against `maxDepth`; what stands between that free witness and a forged inclusion
  proof is hash-arity domain separation (3-input `PoseidonT4` leaves vs 2-input internal nodes).
  That argument is standard but is **not yet written up or tested here** — see open item 5.
- **Fail-closed destination gating.** The Cairo pool's `l1_pool` is immutable and set in its
  constructor. If it is not bound to *our* L1 pool, a relay is a trap. StarkGate still delivers the
  ETH but the note message reverts `NotL1Pool`, so value lands with no note that can ever claim it,
  unrecoverably. `/api/starknet/config` reads the binding from storage and a binding that cannot be
  read or does not match **disables** Starknet in the UI rather than risking the loss.
- **The sender never holds recipient keys.** Enforced by the DEPOSIT / SEND / RECEIVE split.

This code is unaudited testnet software. Please report vulnerabilities privately to the maintainers
rather than opening a public issue.

---

## Status and known gaps

**Working:** variable native-asset deposits with live pool minimum/fee configuration; local note
encryption and mnemonic-based recovery; the full Ethereum → OP Sepolia two-step withdrawal (relay →
activation → L2 proof → withdrawal); Base and Arbitrum destinations; ASP root publishing in the
relayer; ERC-6538 publishing; server-side Garaga calldata conversion (no Python CLI, no paste).

**Gaps and blockers:**

- **The Sepolia L1 pool must be redeployed.** `ProofLib` is a library inlined into `PrivacyPool`
  bytecode, so the deployed pool still carries the old, broken signal accessors. `PrivacyPool` is not
  behind a proxy (only `Entrypoint` is), so no client-side change can fix it.
- **The Starknet path has never run end to end.** The calldata conversion is proven; the chain
  interaction is not. The `STARKNET_*` env vars are unset and public Starknet RPCs were unreachable
  from the dev environment, so the `l1_pool` binding could not be read. It is currently **disabled**,
  not working. Starknet finalization is also not yet wired into RECEIVE, and a Cairo pool bound to
  this L1 pool still has to be deployed.
- Relayer env (`RELAYER_PRIVATE_KEY`, `STARKNET_*`) must be configured, or the relayer falls back to
  the development Anvil key.
- `data.service.spec.ts` never runs (`skipIf(!HYPERSYNC_API_KEY)` against a pool that no longer
  exists). Offline coverage exists; that file should be repointed or deleted rather than sitting
  there looking like coverage.
- The deposit cache is per-process and in-memory: not shared across replicas, lost on restart (a
  cold first request, not a correctness issue).
- No note export/import file yet. The mnemonic makes the vault recoverable, but legacy pre-mnemonic
  notes remain irreplaceable.
- The legacy `test/unit/core/PrivacyPool.t.sol` fixture still targets removed deposit hooks and the
  three-argument deposit signature; production contracts compile.

### Open research items

1. **Unified cross-chain note.** A note in the L2-A shielded pool spendable on L2-B without
   pre-committing a destination. Requires reconciled nullifier sets across chains;
   L1-as-single-nullifier-oracle is the sound design but pays the L2→L1 slow leg (a week on
   optimistic rollups). The highest-leverage question, and the one that would make f5
   unambiguously not a wrapper.
2. **Gas delivery on destination.** Every recipient lands with a shielded note and zero native L2
   gas. With no clear-EOA fallback this is blocking, not optional. Options: the relayer reimbursed
   from the note value, or a bundled native-gas drop.
3. **Scanning throughput.** The view-tag pre-filter is the cheap path, but recipients who don't run
   their own infrastructure need an indexer / light-scan story.
4. **Committee-free amount privacy.** Incremental/recursive folding where each user folds their own
   hidden value and only the per-chain sum is revealed. v2, only if amount privacy becomes
   non-negotiable.
5. **LeanIMT truncation: write up the argument or change the construction.** `actualDepth` is a free
   witness bounded only from above, and the defence is cross-arity Poseidon collision resistance
   rather than structural padding. Needed: an explicit statement of the claim, a negative test that a
   forged internal-node-as-leaf proof is rejected, and a decision on whether to keep the bounded
   design or move to genuine fixed-depth padding. Cheap relative to its blast radius.

---

## License

Apache-2.0. See [`LICENSE`](./LICENSE). Built on the
[Privacy Pool protocol](https://github.com/defi-wonderland/privacy-pool-core) by Wonderland.

# f5: Cross-Chain Private Withdrawals over a Single L1 Privacy Pool

f5 is a single Privacy Pool on Ethereum L1, and it has exactly one withdrawal path: spend an L1
note, canonically bridge its value to a destination L2 shielded pool, and deliver a stealth
commitment into that pool. No public address ever touches the value on either side.

Deposits are destination-agnostic. The destination is a property of the withdrawal rather than of
the deposit, so routing to N chains concentrates one anonymity set instead of fragmenting deposits
across N pools.

> **Status: testnet.** Sepolia L1, with OP Sepolia, Base Sepolia, Arbitrum Sepolia and Starknet
> Sepolia as destinations. All four work end to end. See
> [Status and known gaps](#status-and-known-gaps). This is not production software and it has not
> been audited.

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

The rest of this section follows one note from deposit to spend. It is the only route through f5:
value enters through a single deposit flow, leaves through a single withdrawal circuit, and is
checked against one nullifier set and one ASP association set along the way. No step chooses a
destination type, since every withdrawal produces the same output shape.

### 1. Deposit (L1)

A user deposits `value` of a supported asset into the L1 pool. The browser picks the note secrets
and sends only their hash, so the pool sees a `precommitment` and combines it with the `label` it
assigns to the deposit:

```
precommitment = Poseidon(nullifier, secret)
C_src         = Poseidon(value, label, precommitment)
nullifierHash = Poseidon(nullifier)
```

A vetting fee is deducted first, so the committed `value` is the net amount. `C_src` is inserted into
a LeanIMT state tree (`InternalLeanIMT`, proven in-circuit by the `LeanIMTInclusionProof` instances
inside `WithdrawL1(32)`), whose depth is bounded by `MAX_TREE_DEPTH = 32` at insertion and again
when a proof is verified. The new
root enters a 64-slot circular history buffer (`ROOT_HISTORY_SIZE`). The deposit reveals nothing
about any future destination.

### 2. Sender note construction (off-chain, stealth)

The recipient publishes a shielded address `(B, V)`: a spend key `B = b·G` and a view key
`V = v·G`, both on Baby Jubjub. To send to `(B, V)`:

```
e   ← random scalar          E  = e·G            (ephemeral pubkey)
ss  = e·V                    (recipient recomputes v·E)
P   = B + Poseidon(ss)·G     (one-time owner key)
r   = Poseidon(ss, 1)        (blinding)
C_dest   = Poseidon(P.x, P.y, value, r)          (4-input; P enters as coordinates)
view tag = Poseidon(ss) mod 256                  (low byte; cheap scan pre-filter)
```

Because amounts travel in plaintext, the only secret that must reach the recipient is `E` plus the
view tag, so the "encrypted note blob" collapses to essentially the ephemeral pubkey. Both of them
travel in the L1 `L2Note` event rather than in the bridge message, as
[step 4](#4-canonical-transport-one-or-two-ops-depending-on-the-family) describes.

> **Curve caveat.** `(B, V)` is a 5564-*shaped* meta-address, not a conformant EIP-5564 stealth
> meta-address: different curve, different hash, no Announcer, and `P` is never an Ethereum
> address. It is published to the ERC-6538 registry under a domain-separated `schemeId` (never 1),
> precisely so that conformant secp256k1 tooling ignores it. Without the separation, that tooling
> would read the blob as secp256k1 keys, derive a garbage address, and send real funds there.

### 3. Withdrawal proof (`withdrawL1`)

The circuit has a single branch, and it is always active, because there is no mode for a caller to
select between. A spend does not consume the note it opens: withdrawals are partial, so the circuit
splits the input note's value three ways, into the amount bridged to L2, the relay fee, and an L1
change note that goes back into the state tree.

The circuit exposes ten public signals, ordered by the circuit's declaration order, which puts
outputs first and then inputs:

| idx | signal | | idx | signal |
|---|---|---|---|---|
| 0 | `newCommitmentHashL1`, the L1 change note | | 5 | `stateRoot` |
| 1 | `newCommitmentHashL2`, i.e. `C_dest` | | 6 | `stateTreeDepth` |
| 2 | `existingNullifierHash` | | 7 | `ASPRoot` |
| 3 | `withdrawnValue`, the gross amount spent | | 8 | `ASPTreeDepth` |
| 4 | `bridgedValue`, the net delivered to L2 | | 9 | `context` |

`E`, the view tag, `chainId`, `l2Pool`, the fee recipient and `relayFeeBPS` are not public inputs.
They are bound transitively through
`context = keccak256(abi.encode(Withdrawal{chainId, data}, SCOPE)) % p`, which `relay()` recomputes
and rejects on mismatch (`ContextMismatch`).

The private witnesses are the note preimage (`existingValue`, `existingNullifier`, `existingSecret`,
`label`), the change-note secrets (`newNullifier`, `newSecret`), the recipient's spend key `B`, the
shared secret `ss`, and both Merkle paths. `P` and `r` are derived in-circuit from `B` and `ss`
rather than supplied.

Eight constraints hold the whole thing together:

| # | Constraint | Why |
|---|---|---|
| 1 | L1 inclusion: `C_src` under a public historical root | the note exists |
| 2 | `existingNullifierHash = Poseidon(nullifier)`, derived from the same preimage | no double spend |
| 3 | Spend authorization, implicit in 1 and 2: only the holder of `(nullifier, secret)` can open the commitment | only the owner spends |
| 4 | ASP association: `label` is in the approved set | portable L1 compliance, checked once |
| 5 | Conservation, three ways: `remainingValue = existingValue − withdrawnValue` (128-bit range-checked, which is the underflow guard) becomes the L1 change note, and `bridgedValue ≤ withdrawnValue`, the gap being the relay fee | two outputs rather than one, and the contract pins the fee exactly (`BridgedValueMismatch`) |
| 6 | Change-note freshness: `newNullifier ≠ existingNullifier` | a change note cannot reuse the burnt nullifier |
| 7 | Value binding: `C_dest` is hashed over `bridgedValue` | without it, a prover mints unbacked L2 supply |
| 8 | Anti-theft binding via `context`: `chainId`, `l2Pool`, fee recipient, `relayFeeBPS` | a stolen proof cannot be re-targeted or re-priced |

A botched stealth derivation only griefs the sender and can never threaten pool soundness, so
nothing about the stealth math is constrained beyond the value field.

Proofs are generated client-side, in a Web Worker (`app/src/prover.worker.js`), and submitted to L1
by a relayer.

### 4. Canonical transport: one or two ops, depending on the family

On proof acceptance the L1 pool burns the note (`nullifierHash` marked spent) and hands the value
and the note to the canonical bridge. How many operations that takes depends on the family, and
OP-Stack is the only one that always takes two; see [Bridge families](#bridge-families) for the full
comparison. The two-op case is described here because it is the hard one, and the single-op
families are a strict simplification of it.

On OP-Stack, two operations cross to L2:

1. `bridgeETHTo{value}(l2Pool, tokenGasLimit, "")` moves the value. This is a native-ETH pool, so
   that is the branch `_bridgeOpStack` takes; the ERC20 branch calls `bridgeERC20To` instead.
2. `sendMessage(l2Pool, IL2Pool.deposit(value, commitmentHash))` carries the note. `value` rides in
   cleartext because the pool cannot read it out of the hash.

The pool sends them in that order deliberately, so the token bridge gets the earliest possible
inclusion and an unbacked commitment is never knowingly put in flight first.

The message carries only `(value, C_dest)`. `E` and the view tag are not in it, because the
destination pool has no use for them. They are emitted on L1 as
`L2Note(C_dest, ephemeralKey, viewTag)`, which is where recipients scan for them.

That L1 ordering buys nothing on the other side: the two operations are relayed independently and
arrive in separate L2 transactions in either order. So the L2 pool enforces three things on-chain:

- Cross-domain auth. The note must provably originate from `L1Pool`, or anyone can mint backed
  claims. How that origin is proven differs by bridge family (see [below](#bridge-families)).
- The backing invariant, `activatedSupply + value ≤ tokensReceivedFromBridge()`. A note is inserted
  as pending and becomes spendable only once matching bridged tokens have landed, which is what
  makes the unordered two-op split safe.
- The finality gate, which is free on OP-Stack: deposits derive from finalized L1 state, giving
  reorg safety across the whole path.

Where delivery is a single op, which covers every Starknet note and the native Arbitrum ones, none
of that reconciliation is needed. The tokens are already credited when the note handler runs, so the
backing check passes inline and the note is inserted and spendable in the same transaction
(`NoteReceived` and `NoteActivated` emit together). Nothing has to scan for it and no second
transaction is required.

### 5. Recipient spend (L2)

Scanning is a two-chain join. The stealth material and the value are emitted on different chains and
the recipient needs both halves: `(E, viewTag)` from the L1 `L2Note` event, joined on `C_dest` with
the cleartext `value`, which only exists once the tokens land on the destination
(`buildScannableNotes` in `app/server/pool-events.mjs`). A delivery with no matching arrival is
dropped, because it means the bridge has not settled yet.

Given the join, the view-tag byte filters cheaply, then `v·E` confirms `ss` and recomputes `P`. To
spend, the recipient derives `b + Poseidon(ss)` and opens the Poseidon ownership constraint inside
the L2 circuit. The key enters the proof as a witness, and at no point does the recipient sign an
Ethereum transaction to authorize the spend.

This is why Baby Jubjub is forced and secp256k1 is not: the spend key authorizes a commitment
opening in-circuit, and it does not sign a transaction.

From there it is an ordinary L2 pool spend. The recipient can exit to a clear address, re-shield, or
go onward to another chain recursively.

### Cross-chain nullifiers

No shared nullifier set is required. `C_src` dies on L1 at spend, and `C_dest` is a fresh note that
could not have existed before value physically crossed. Double-spend-across-chains is structurally
impossible, which is exactly why per-hop burn-and-mint is buildable today while the *unified
cross-chain note* remains an open research item.

### Self-bridge

Moving your own funds to spend privately on L2 is a strict special case of the third-party send
rather than a separate path. ECDH is redundant because you hold `v`, scanning is skipped, and there
is no counterparty key provisioning. The on-chain footprint is nonetheless byte-identical to a
third-party send, since emitting a distinguishable "self" shape would create observable sub-buckets
that fragment the anonymity set. The divergence lives only in the wallet.

### What is explicitly out of scope

Value privacy is the one property f5 does not attempt. Amounts are forwarded in plaintext and every
withdrawal publishes `withdrawnValue`. Conservation is enforced by in-circuit range checks and an
ordering constraint, so there is no blinded aggregate, no range proof over a hidden sum, and no
wraparound vector.

The amount is therefore the dominant residual leak, though it is a weaker one than a
same-denomination bound. Because withdrawals are partial and the change note's value is never
emitted (only its commitment hash), a published `withdrawnValue = W` is consistent with spending any
unspent note of value at least `W`. The candidate set is `{unspent notes ≥ W}` rather than
`{notes = W}`. This is an accepted trade-off and not an oversight.

---

## Repository layout

The repository is a Yarn workspaces monorepo, with one deliberate exception: `app/` is not a
workspace. It reuses the repository's existing `node_modules` during development, so installing the
core packages does not require resolving a second dependency graph.

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

> **Never hand-derive `withdrawL1` public-signal indices.** Circom numbers public signals by the
> template's declaration order, outputs first and then inputs, and not by the order listed in
> `component main {public [...]}`. Getting this wrong once silently bricked every relay in three
> layers at once, and the old test compared the three hand-written copies against each other, so the
> suite passed anyway. `packages/sdk/test/unit/withdrawalSignals.spec.ts` now reconciles four
> independently produced sources (the generated verifier's `nPublic`, the circuit `.sym`,
> `ProofLib.sol`, and the SDK map), so a circuit change fails the build instead. Read the
> authoritative order out of `packages/circuits/build/withdrawL1/withdrawL1.sym` and never off a
> hand-written table.

---

## Quick start

### Prerequisites

- Node.js and Yarn (Yarn workspaces)
- [Foundry](https://book.getfoundry.sh/) for contracts
- [`circom`](https://github.com/iden3/circom/releases/tag/v2.2.1) v2.2.1 and `snarkjs` for
  circuit work. Install the released binary; CI pins the same version
  (`.github/workflows/circuits.yml`). Do not vendor the compiler source into this repo.
- `scarb` 2.16.1 and `starknet-foundry` 0.57.0 for the Cairo pool (pinned in
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

The Vite client runs on `5173` and the API on `8787`. The `dev` script starts both with a small Node
runner, so no global `concurrently` is needed. Vite hot-reloads the client, but you have to restart
the API yourself after server changes.

Set `PUBLIC_RPC_URL`, `POOL_ADDRESS` and `DEPLOYMENT_BLOCK` for SDK-backed pool activity and user
deposits; the `L2_*` values for note indexing, bridge status and reconstructed L2 Merkle proofs; and
`RELAYER_API_URL` to proxy the real relayer. For the recorded Sepolia deployment, start from
`app/.env.sepolia.example`.

The browser generates the commitment preimage and sends the deposit from the connected wallet, so
the relayer never receives the note secret. The UI is split into DEPOSIT, SEND and RECEIVE so that a
sender can never hold the recipient's private keys.

### Run the production relayer

```bash
cp packages/relayer/config.sepolia.example.json /private/path/config.sepolia.json
# fill in the deployed Entrypoint, fee receiver, and relayer key
CONFIG_PATH=/private/path/config.sepolia.json PORT=8788 \
  yarn workspace @f5/relayer build:start
```

The app proxies `/api/relayer/quote` and `/api/relayer/request` to it, and forwards activation
requests to `/relayer/destinations/<key>/activate`. The app server holds no relayer key of its own:
it is a read-only chain indexer plus a proxy, so with no relayer configured those routes fail rather
than falling back to signing anything locally.

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

The bridge is inlined into `PrivacyPool`, with no adapter contract in the value path. `_bridge`
dispatches on a `BridgeKind` discriminator stored in a per-`(chain, token)` `BridgeConfig`, which
the `Entrypoint` owns and exposes through `setBridgeConfig` and `getBridgeConfig`. Adding a
destination chain is therefore one config row, while adding a destination *family* is a new code
path in the pool itself.

| | OP-Stack (Optimism, Base) | Arbitrum (One / Nova) | Starknet |
|---|---|---|---|
| Note message | `L1CrossDomainMessenger.sendMessage` | Inbox `createRetryableTicket` | inside `depositWithMessage` |
| Token lock | `L1StandardBridge.bridge{ERC20,ETH}To` | Gateway Router `outboundTransferCustomRefund` | StarkGate `depositWithMessage` |
| Destination id | 20-byte `l2Pool` | 20-byte `l2Pool` | `l2PoolFelt` (felt252) |
| L1→L2 fee | none (L1-derived gas) | `submissionCost + gasLimit·maxFeePerGas`, per op | one flat StarkGate fee |
| Native value | `bridgeETHTo{value}` | rides as retryable `l2CallValue` (single ticket) | rides in `depositWithMessage{value}` |
| Auth on L2 | `xDomainMessageSender == L1Pool` | `undoL1ToL2Alias(msg.sender) == L1Pool` | `l1_pool`, written once in the constructor |
| Code path | `_bridgeOpStack` | `_bridgeArbitrum` | `_bridgeStarknet` |

Arbitrum has no L2 messenger, so the note arrives as a direct call whose `msg.sender` is the L1
pool's *aliased* address, which is what the `AddressAliasHelper` check is for.

The op count per family is what decides whether activation is a separate step:

| Family | L1 ops | Activation |
|---|---|---|
| OP-Stack | 2 (always) | separate transaction, after the backing lands |
| Arbitrum | 1 native / 2 ERC20 | inline for native (`l2CallValue` is credited with the ticket), separate for ERC20 |
| Starknet | 1 (always) | inline, always |

Arbitrum native ETH collapses to a single retryable carrying value as `l2CallValue`, so it delivers
one op rather than two. Starknet is single-op in every case: `depositWithMessage` carries the
commitment as its message payload, and StarkGate credits the tokens before invoking the pool's
authenticated `on_receive`, which activates the note in the same call. `activate_note` on the Cairo
pool is therefore unreachable on Starknet. The only entrypoint that could leave a note pending is
`#[l1_handler] receive_note`, and no L1 code sends the raw Starknet Core message that would invoke
it.

Fees for the L1 to L2 hop work like this. `relay` is `payable`, and because Arbitrum and Starknet
charge for L1→L2 execution up front, the relayer prepays that charge as `msg.value` and the pool
refunds whatever is left over (`msg.value − feeSpent`). Each such path checks
`msg.value ≥ requiredFee` and reverts `InsufficientBridgeFee` otherwise. The pool
never uses its own principal to pay L1→L2 fees, which matters most for native pools whose ETH
balance would otherwise be raided for gas. The relayer is reimbursed through the relay fee it
already collects, and the SDK must forward this `msg.value` for Arbitrum and Starknet destinations.
This is the messaging fee, and it is a different problem from giving the recipient native gas on the
destination, which is still open.

The `BridgeConfig` struct is a flat union spanning all three families, tagged by `kind`, with fields
unused by a given kind left zero and documented per field in `IEntrypoint.sol`.

---

## Identity and key derivation

One twelve-word mnemonic is the root of the entire identity, and it is the only thing a user backs
up.

| Derived material | HD account |
|---|---|
| `masterNullifier`, `masterSecret` (L1 note secrets) | 0, 1 |
| `b`, `v` (shielded spend + view keys) | 2, 3 |
| local vault encryption key | 4 |

Nothing is derived from a wallet signature. Signatures are only deterministic for RFC-6979 signers,
and plenty of smart-contract wallets and WalletConnect implementations are not, so a signature that
came back different once would mean keys that can never be re-derived. A wallet, or a password, may
*unwrap* the stored mnemonic, but neither is ever the source of a key, which makes a wallet change
or a non-deterministic signer recoverable rather than fatal. The password path also lets a pure
recipient use RECEIVE with no EOA connected at all, which is the whole point of a stealth address.

The note vault is a cache rather than the source of truth. Deposit secrets are
`Poseidon(master, scope, index)`, so `recoverNotes()` rebuilds every L1 note from the mnemonic plus
public `Deposited` events. Losing `localStorage` therefore costs a user nothing they cannot rebuild.
Deposit indices come from chain state rather than from a local counter, because two devices sharing
a mnemonic would otherwise derive the same precommitment and the second deposit would revert
`PrecommitmentAlreadyUsed`.

---

## Deployments

Recorded EVM addresses live in `packages/contracts/deployments/<chainId>.json`. Starknet is recorded
separately, in `packages/starknet-pool/deployments/starknet-<chainId felt>.json`, because it is a
Cairo deployment with a class hash and a felt-encoded chain id rather than an EVM one.

| Chain | ID | Role |
|---|---|---|
| Sepolia | 11155111 | L1 pool, Entrypoint, verifiers |
| OP Sepolia | 11155420 | `L2PrivacyPool` destination |
| Base Sepolia | 84532 | `L2PrivacyPool` destination |
| Arbitrum Sepolia | 421614 | `L2PrivacyPoolArbitrum` destination |
| Starknet Sepolia | `SN_SEPOLIA` | `StarknetPrivacyPool` and its Garaga verifier |

The Starknet record pins the `l1Pool` its pool is bound to, which is the same Sepolia pool listed
above. That binding is what the fail-closed gate in [Security posture](#security-posture) checks,
so it is worth confirming the two match after any L1 redeploy.

Deploy and configure scripts are Foundry scripts under `packages/contracts/script`, wired to yarn
scripts (`deploy:l2:*`, `configure:bridge:*`, `update:l1:root:sepolia`, `bridge:funds:op-sepolia`,
and so on). Run `yarn check:deployment --onchain` to verify a deployment against live RPCs.

---

## Testing and verification

Beyond unit tests, several invariants are pinned by tests that read both sides from source instead
of comparing hand-written copies to each other:

- The public-signal layout is pinned by `withdrawalSignals.spec.ts`, which reconciles the generated
  verifier, the circuit `.sym`, `ProofLib.sol` and the SDK map against each other.
- The indexer's event ABIs are pinned by `eventAbis.spec.ts`, which reads the Solidity interface and
  the indexer's own `parseAbiItem` strings and asserts that names, order and `topic0` all agree.
  Both failure modes it guards against are silent ones. A field can be misnamed while the types
  still line up, so decoding works by accident until a rename breaks it and notes become
  unrecoverable. A signature can diverge outright, which changes `topic0`, leaves
  `getWithdrawals()` matching nothing and returning `[]` forever, and makes spent notes look
  unspent.
- Poseidon parity between the two implementations is checked by the Cairo pool, which asserts that
  Garaga's Poseidon reproduces the circomlib LeanIMT root.
- The Starknet flow is covered end to end by a fork test that runs StarkGate intake, then backing
  and activation, then checks that the on-chain root equals the circuit's `stateRoot`, and finally
  performs a real Groth16 `withdraw`. A companion negative test confirms that intake rejects a wrong
  L1 sender.
- Decoding is validated against a real encoded `Deposited` log in `depositEvent.spec.ts`, which
  decodes it and confirms the note it yields is one the mnemonic recovers, so the ABI and the
  derivation are checked against the same bytes.

Two flows are also exercised end to end. The first is a third-party send round-trip, where a note
built from only `(B, V)` is found by a recipient scanning with `(b, v)` while decoys and strangers
match nothing. The second is the full identity lifecycle: generate a phrase, deposit at
chain-derived indices, wipe local storage, recover every note from the phrase alone, publish to the
registry, have a sender who only ever sees the registry blob pay it, and have the recipient scan and
find it.

---

## Emergency ragequit

Ragequit is the L1 pool's emergency exit for a depositor whose note cannot use the normal
ASP-approved withdrawal path. It is not a private withdrawal: the transaction publicly links the
original deposit address, the commitment, and the amount returned.

Only the EOA that originally deposited the note may call `ragequit`, and that same address must pay
the L1 gas. The pool checks `msg.sender` against `depositors[label]` and reverts
`OnlyOriginalDepositor` otherwise, so a relayer cannot submit it on the depositor's behalf. The
caller still has to supply a Groth16 ragequit proof, and the commitment must be present in the state
tree. A successful ragequit is irreversible and burns the note's nullifier.
It remains available after the pool is wound down, so depositors keep an exit of last resort.

---

## Security posture

- Bridging is canonical only, so there is no third-party bridge trust surface. Any intent or solver
  fast-path would reintroduce one, which is why such a path stays opt-in and never becomes the
  default.
- L1 compliance is portable. ASP association is checked once at L1 and inherited by the delivered L2
  note, so there is no standing committee, no subpoenable quorum, and no permanent ciphertext to
  enable retroactive de-anonymization.
- The LeanIMT is bounded in depth rather than fixed. On-chain the bound is enforced twice:
  `State._insert` reverts `MaxTreeDepthReached` past `MAX_TREE_DEPTH = 32`, and `relay()` rejects a
  proof declaring a larger `stateTreeDepth` or `ASPTreeDepth` (`InvalidTreeDepth`). In-circuit,
  `actualDepth` is a free witness bounded only from above, so what stops a forged inclusion proof is
  hash-arity domain separation: leaves are 3-input `PoseidonT4` outputs and internal nodes are
  2-input. That argument is standard but untested here, which is open item 5.
- Destination gating fails closed. The Cairo pool's `l1_pool` is written once in the constructor and
  has no setter, and a pool bound to the wrong L1 address turns a relay into a trap: StarkGate
  delivers the ETH, the note message reverts `NotL1Pool`, and the value lands with no note that can
  ever claim it. `/api/starknet/config` therefore reads the binding from the chain and requires both
  a matching L1 pool and a signing relayer. If either check fails, or the binding cannot be read at
  all, the route reports Starknet unusable rather than risking the loss.
- The sender never holds the recipient's keys, which the DEPOSIT / SEND / RECEIVE split enforces.

This code is unaudited testnet software. Please report vulnerabilities privately to the maintainers
rather than opening a public issue.

---

## Status and known gaps

Working today: variable native-asset deposits with live pool minimum and fee configuration; local
note encryption and mnemonic-based recovery; the full Ethereum to OP Sepolia two-step withdrawal
(relay, activation, L2 proof, withdrawal); Base, Arbitrum and Starknet destinations, the last
delivering value and note in a single op so the note is spendable on arrival; ASP root publishing
from the relayer's testnet ASP service; ERC-6538 publishing; and server-side Garaga calldata
conversion, with no Python CLI and no pasting.

The one structural gap is that supporting a new bridge family means redeploying the L1 pool. Adding
a destination chain within a family that already exists is only a config row, because `_bridge`
reads a per-`(chain, token)` `BridgeConfig` from the `Entrypoint`, which sits behind a proxy and can
be updated in place. A fourth family is a different matter: the dispatch in `PrivacyPool._bridge` is
a hard-coded branch over the three `BridgeKind` values, `PrivacyPool` is not proxied, and libraries
such as `ProofLib` are inlined into its bytecode. Nothing configured on the `Entrypoint`, and no
change on the client, can reach code that is not in the deployed pool.

That constraint is also the clearest place the contract architecture could improve. Inlining the
bridge dispatch keeps the value path free of adapter contracts and free of the trust surface an
adapter registry would add, which was the point of the design, but it pays for that by baking the
set of supported families into immutable bytecode. Any future work here has to weigh keeping the
value path direct against being able to add a family without moving the pool and its anonymity set.

### Open research items

1. The unified cross-chain note: a note in the L2-A pool that is spendable on L2-B without having
   pre-committed to a destination. It needs nullifier sets reconciled across chains, and the sound
   design uses L1 as the single oracle, which pays the L2 to L1 slow leg of about a week on
   optimistic rollups. This is the highest-leverage question left.
2. Self-submitted L2 spends. The relayed path is covered, since the destination relayer submits the
   L2 withdrawal and takes its fee out of the note through `feeRecipient` and `relayFeeBPS`. A
   recipient who wants to submit their own spend still has no native gas to do it with, which would
   need a native-gas drop bundled with delivery.
3. Scanning for recipients without infrastructure. The view-tag pre-filter works and the SDK has a
   Hypersync-backed `DataService`, but both assume a server. What is missing is a light-scan path
   for a recipient running nothing of their own.
4. Committee-free amount privacy, through recursive folding where each user folds their own hidden
   value and only the per-chain sum is revealed. A v2 item, worth picking up only if amount privacy
   becomes non-negotiable.
5. LeanIMT truncation: write up the argument or change the construction. `actualDepth` is a free
   witness bounded only from above, defended by cross-arity Poseidon collision resistance rather
   than by padding. Closing it needs the claim stated, a negative test that a forged
   internal-node-as-leaf proof is rejected, and a decision on whether to keep the bounded design.
   Still entirely open, with no test in the repo touching it.

---

## License

Apache-2.0. See [`LICENSE`](./LICENSE). Built on the
[Privacy Pool protocol](https://github.com/defi-wonderland/privacy-pool-core) by Wonderland.

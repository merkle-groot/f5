# F5 Privacy Pools Progress

## Completed

- F5 landing page and relay UI aligned with the supplied visual direction.
- Variable native-asset deposits with live pool minimum/fee configuration.
- Local note encryption/unlocking, including legacy-note compatibility.
- Input validation for amounts, addresses, relayer quotes, and proof requests.
- Sepolia L1 and OP Sepolia deployment configuration.
- Integrated testnet ASP root publishing in the relayer.
- Full Ethereum → OP Sepolia two-step withdrawal flow: relay, activation, L2 proof, withdrawal.
- Starknet Sepolia destination support: L1 relay to a Starknet destination (send side).
- **Arbitrum destination support (both sides):** L1 `_bridgeArbitrum` (retryable ticket + gateway,
  native single-ticket, fee floor/refund) and the delivery-side `L2PrivacyPoolArbitrum`, which
  inherits the L2 pool and swaps OP-Stack messenger auth for Arbitrum address aliasing
  (`AddressAliasHelper`). SDK forwards the per-destination `msg.value`; the relayer prices that
  fronted L1→L2 fee into its quote (`destinationChainId`). Deploy via `DeployL2Arbitrum.s.sol` +
  `ConfigureArbitrumBridge.s.sol`. Unit-tested; a real-retryable fork test and mainnet endpoint
  confirmation remain before production use.
- Added `UpdateL1.s.sol` for L1 ASP-root and pool-configuration updates.
- Added `BridgeFunds.s.sol` for target-specific native ETH funding of supported OP Stack L2 relayers.
- **Corrected the `withdrawL1` public-signal layout** (see below) and pinned it to the circuit.
- **Split the UI into DEPOSIT / SEND / RECEIVE** so the sender can no longer hold the recipient's
  private keys.

## The `withdrawL1` public-signal layout

Circom numbers public signals by the **template's declaration order** (outputs first, then inputs),
NOT by the order listed in `component main {public [...]}`. `withdrawL1.circom` declares
`bridgedValue` second, immediately after `withdrawnValue`, so it occupies index **4** even though the
`main` list names it last.

The shipped code followed the `main` list and placed `bridgedValue` at 9, shifting
`stateRoot`..`context` down by one. Consequences:

- `PrivacyPool.relay()` read `context` from slot 8 (actually `ASPTreeDepth`) → **every L1 relay
  reverted with `ContextMismatch`**.
- The relayer read `bridgedValue` from slot 9 (actually `context`) → **every request was rejected
  with a bridged-value mismatch before it ever broadcast**.

The same wrong table had been copied into three layers (`ProofLib.sol`, the relayer's `parseSignals`,
and the SDK's `WITHDRAW_L1_SIGNALS`), and the old test compared those hand-written copies **against
each other** — so they agreed, the suite passed, and the relay was totally broken.

Authoritative order (from `packages/circuits/build/withdrawL1/withdrawL1.sym`):

| idx | signal | idx | signal |
|---|---|---|---|
| 0 | `newCommitmentHashL1` | 5 | `stateRoot` |
| 1 | `newCommitmentHashL2` (`C_dest`) | 6 | `stateTreeDepth` |
| 2 | `existingNullifierHash` | 7 | `ASPRoot` |
| 3 | `withdrawnValue` | 8 | `ASPTreeDepth` |
| 4 | **`bridgedValue`** | 9 | `context` |

`packages/sdk/test/unit/withdrawalSignals.spec.ts` now reconciles four independently-produced
sources — the generated verifier (`nPublic`), the circuit `.sym` (order), `ProofLib.sol`, and the SDK
map — so a circuit change that moves a signal fails the build instead of bricking withdrawals.
Never re-derive these indices by hand.

## One mnemonic is the root of the identity

Everything derives from twelve words, so the phrase is the **only** thing a user backs up:

| Derived | HD account |
|---|---|
| `masterNullifier`, `masterSecret` (L1 note secrets) | 0, 1 |
| `b`, `v` (shielded spend + view keys) | 2, 3 |
| local vault encryption key | 4 |

**Nothing is derived from a wallet signature.** Signatures are only deterministic for RFC-6979
signers, and plenty of smart-contract wallets and WalletConnect implementations are not — a signature
that came back different once would mean keys that can never be re-derived. A wallet (or a password)
may *unwrap* the stored mnemonic, but it is never the source of a key, so a wallet change or a
non-deterministic signer is recoverable rather than fatal. The password path also lets a pure
recipient use RECEIVE with no EOA connected at all, which is the point of a stealth address.

**The note vault is now a cache, not the source of truth.** Deposit secrets are
`Poseidon(master, scope, index)`, so `recoverNotes()` rebuilds every L1 note from the mnemonic plus
public `Deposited` events (`GET /api/l1/deposits`). Losing `localStorage` is survivable. Deposit
indices come from chain state, not a local counter — two devices sharing a mnemonic would otherwise
derive the same precommitment and the second deposit would revert `PrecommitmentAlreadyUsed`.

Notes written before the mnemonic existed used pure local entropy and are NOT re-derivable; both
legacy vault messages are tried on unlock and those notes are migrated into the new vault.

## ERC-6538 publishing

`(B, V)` is published to the canonical registry at `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538`
(live on Sepolia) under a **domain-separated `schemeId`, never 1**. SchemeId 1 is secp256k1 + keccak
with a real Ethereum address in the value path; ours is Baby Jubjub + Poseidon and `P` is never an
address. A conformant ERC-5564 wallet reading our blob as secp256k1 keys would derive a garbage
address and send real funds to it. Our id keeps conformant tooling correctly ignoring us.

The ERC-5564 **Announcer** (`0x5564…5564`) is deliberately NOT used — it only has `announce()`, and
Mode 3 already carries `E` in the note message (CLAUDE.md §10). Senders resolve a recipient by EOA
via `stealthMetaAddressOf`, or paste the raw points; registration stays optional.

## Indexer event ABIs are pinned to the contract

`DataService` filters logs by `topic0`, derived from an event's name and parameter TYPES. Its
hand-written ABIs had drifted from the contract in two different ways, and BOTH were silent:

- **`Deposited`** named its 5th field `_merkleRoot`; the contract emits `_precommitmentHash`. Types
  matched, so `topic0` matched and it decoded *by accident*. Note recovery matches on exactly this
  field, so a well-meaning rename would have silently made notes unrecoverable.
- **`Withdrawn`** still had the pre-Mode-3 shape (`address indexed _processooor, …`). The types
  differ, so `topic0` differed, so **`getWithdrawals()` matched nothing and returned `[]` forever** —
  and `AccountService` reconstructs spent state from it, so it was treating spent notes as unspent.

Neither raised an error, and nothing caught them: `data.service.spec.ts` is
`describe.skipIf(!HYPERSYNC_API_KEY)` against a pool that is no longer deployed, so it has never run.

`eventAbis.spec.ts` now reads BOTH sides from source — the Solidity interface and the indexer's own
`parseAbiItem` strings — and asserts names, order and `topic0` all agree. It also pins the two failure
modes: a type change breaks `topic0`, while a name-only change does not, which is why `topic0` parity
alone is not sufficient. `data.service.offline.spec.ts` covers the decode path, the scan join and the
tree reconstruction without a network.

## Starknet finalization

Garaga calldata used to be a manual step — the UI made the recipient run the `garaga` **Python CLI**
and paste a felt array into a textarea. Garaga publishes the same logic as a WASM package at the same
version, so `/api/starknet/calldata` now does the conversion server-side and the recipient never sees
it. `/api/starknet/index` joins the L1 `L2Note` deliveries (which carry `E` + view tag regardless of
destination) with the Cairo pool's `NoteReceived`/`NoteActivated` events, so Starknet notes are
scannable exactly like OP-Stack ones.

**The Starknet destination is fail-closed.** The Cairo pool's `l1_pool` is immutable and set in its
constructor. If it is not bound to *our* L1 pool, a relay is a trap: StarkGate still delivers the ETH,
but the note message reverts `NotL1Pool`, so the value lands with no note that can ever claim it —
unrecoverable. `/api/starknet/config` reads the binding from storage (`sn_keccak("l1_pool")`) and
`configured` requires `l1PoolMatches === true`, so a binding that cannot be read or does not match
DISABLES Starknet in the UI rather than risking the loss.

## Verification

- SDK: typecheck clean (it had never passed) + 200 tests passing, 5 skipped.
- Relayer: typecheck clean + 15 tests passing, 1 skipped.
- App: syntax check and production build passing.
- Contracts: production build passing with warnings.
- Real Groth16 proof generated from the production zkey; signals land where all three layers read
  them.
- Third-party send round-trip: a note built from only `(B, V)` is found by the recipient scanning
  with `(b, v)`; decoys and strangers match nothing.
- Full identity lifecycle: generate phrase → derive → deposit at chain-derived indices → **wipe local
  storage** → recover every note from the phrase alone → publish to the registry → a sender who only
  ever sees the registry blob pays it → the recipient scans and finds the note.
- **Indexer decoding validated against the live chain**: 713 real `Deposited` logs from Sepolia all
  satisfy `Poseidon(value, label, precommitment) === commitment`, proving the 5th field really is the
  precommitment.
- **Garaga calldata generated in JS** from a real, verified `withdrawL2` proof (1992 felts) — no
  Python CLI, no paste.

### Not verified

- **The Starknet path has never been exercised end to end.** `STARKNET_RPC_URL`,
  `STARKNET_RELAYER_ADDRESS` and `STARKNET_RELAYER_PRIVATE_KEY` are all empty, and public Starknet
  RPCs were unreachable from the dev environment, so the `l1_pool` binding could not be read and the
  index/activate/withdraw calls were never run against a live pool. The calldata conversion is proven;
  the chain interaction is not. The gate is fail-closed, so this is safe by default — but it means
  Starknet is currently DISABLED, not working.
- The relayer's integration CLI is ported to `proveWithdrawalL1` and typechecks, but it needs a live
  chain plus a running relayer to execute; it has not been run.

## Remaining deployment actions

- **Redeploy the Sepolia L1 pool.** `ProofLib` is a library inlined into `PrivacyPool` bytecode, and
  the deployed pool at `0x98657a…b3a2` carries the OLD (broken) accessors. The corrected code cannot
  take effect until the pool is redeployed — no client-side change can fix an immutable contract.
  `PrivacyPool` is not behind a proxy (only `Entrypoint` is).
- Configure `RELAYER_PRIVATE_KEY` with the funded EVM testnet relayer key; otherwise the relayer
  falls back to the development Anvil key.
- Configure `STARKNET_RPC_URL`, `STARKNET_RELAYER_ADDRESS`, and
  `STARKNET_RELAYER_PRIVATE_KEY` for Starknet finalization.
- The legacy `test/unit/core/PrivacyPool.t.sol` fixture still targets the removed deposit hooks
  and three-argument deposit signature; production contracts compile successfully.

## Known gaps

- **Starknet finalization is not wired into RECEIVE.** The L1 relay to a Starknet destination works,
  but `/api/mode3/index` only indexes the OP-Stack L2 pool, so Starknet notes cannot be scanned. The
  previous Starknet finalize path only ever worked for a self-bridge in the same browser session.
- **A Starknet Cairo pool bound to this L1 pool must be deployed**, and the Starknet env vars filled
  in, before the Starknet destination can be enabled. Until then it is correctly disabled in the UI.
- **`data.service.spec.ts` still never runs.** It is `skipIf(!HYPERSYNC_API_KEY)` against a pool that
  is no longer deployed. The decode/scan/tree paths are now covered offline, but that file should
  either be repointed at the live pool or deleted, rather than sitting there looking like coverage.
- **The deposit cache is per-process and in-memory.** It is not shared across replicas and is lost on
  restart (which is only a cold first request, not a correctness issue).
- **No note export/import file yet.** The mnemonic makes the vault recoverable, so this is now a
  portability convenience rather than a safety net — but legacy (pre-mnemonic) notes are still
  irreplaceable and would benefit from an export.

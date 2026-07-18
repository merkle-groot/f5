# What was broken, and what fixed it

A record of the defects found and repaired across the contracts, circuits, SDK, relayer and app.

Written for whoever touches this next. Several of these bugs were invisible — they passed tests,
compiled cleanly, and produced no error — so the *why it was silent* matters as much as the fix.

---

## The pattern

Almost every serious bug here was the same shape:

> **A hand-maintained copy of a layout drifted from its source of truth, and the thing that was
> supposed to catch it compared two hand-maintained copies against each other.**

It happened three times, in three different costumes:

| The copy | The truth | How it drifted |
|---|---|---|
| `ProofLib.sol` + `WITHDRAW_L1_SIGNALS` + `parseSignals` | the circom circuit | signal indices shifted by one |
| `app/package.json` SDK pin | the workspace SDK | resolved to the registry package instead |
| `DataService`'s event ABIs | the Solidity interface | wrong field name; wrong event shape |

Two copies agreeing proves only that someone was consistently wrong. **Every guard added here reads
both sides from source.** That is the single most important thing to preserve.

---

## 0. The master keys had ~53 bits of entropy, not 256

**Severity: critical. Silent. Found while writing the key-derivation doc.**

`generateMasterKeys` ran the 32-byte HD private key through viem's **`bytesToNumber`**, which returns a
JavaScript `number` — an IEEE-754 double. A 256-bit key is ~7.8e76, far past `Number.MAX_SAFE_INTEGER`
(2^53), so the double kept only its 53-bit mantissa and **silently rounded**:

```
true key                 77814517325470205911140941194401928579557062014761831930645393041380819009408
BigInt(bytesToNumber(k)) 77814517325470206090537488703115359743174939106526186048988649279981784924160
                                           ^^^ diverges — the low ~203 bits are zeroed
```

A double in `[2^255, 2^256)` can only land on multiples of `2^203`. So `masterNullifier` and
`masterSecret` — which seed **every L1 note secret** — each carried roughly **53 bits of entropy
instead of 256**, and the value being hashed was not even the real private key.

Nothing threw. It is invisible unless you compare the derived value against the raw bytes.

**Worse: the derivation existed in two places.** `AccountService._initializeAccount` carried its own
copy of the same logic, with the same `bytesToNumber` — the pattern again. The fix deletes the copy and
delegates to `generateMasterKeys`.

**Fixed** with `bytesToBigInt`. Pinned by `identity.spec.ts` → *"master keys use the FULL 32 bytes of HD
entropy"*, which also asserts that the lossy conversion really does destroy the key.

> ⚠️ **This was safe to fix only because the pool had zero deposits.** Changing the derivation changes
> every derived note secret: existing notes would become underivable, and therefore **unspendable**.
> After real deposits exist, this is a versioned migration, not a bug fix.

See `docs/KEY-DERIVATION.md`.

---

## 1. Every L1 withdrawal reverted — wrong public-signal order

**Severity: critical. The core flow was 100% broken.**

Circom numbers public signals by the **template's signal DECLARATION order** (outputs first, then
inputs). It does **not** use the order written in `component main {public [...]}`.

`withdrawL1.circom` declares `bridgedValue` second, immediately after `withdrawnValue` — so it lands
at index **4**. But the `main` list names it *last*, and all three consumers followed the `main` list
and put it at index **9**, shifting `stateRoot`…`context` down by one.

| idx | Circuit (truth) | What the code read |
|---|---|---|
| 3 | `withdrawnValue` | `withdrawnValue` ✅ |
| 4 | **`bridgedValue`** | `stateRoot` ❌ |
| 5 | **`stateRoot`** | `stateTreeDepth` ❌ |
| 6 | **`stateTreeDepth`** | `ASPRoot` ❌ |
| 7 | **`ASPRoot`** | `ASPTreeDepth` ❌ |
| 8 | **`ASPTreeDepth`** | `context` ❌ |
| 9 | **`context`** | `bridgedValue` ❌ |

**Blast radius**

- `PrivacyPool.relay()` read `context` from slot 8 (actually `ASPTreeDepth`) → **every L1 relay
  reverted with `ContextMismatch`.**
- The relayer read `bridgedValue` from slot 9 (actually `context`, a huge number) → **every request
  was rejected with a bridged-value mismatch before it ever broadcast.**

**Why it was silent.** The regression test compared the SDK's index map against `ProofLib.sol` — *two
hand-written copies*. They agreed, so it passed, while the relay was totally dead. Nothing was ever
anchored to the circuit. `PROGRESS.md` even claimed this had been "fixed"; it had been fixed *wrong*.

**Fixed in**
- `packages/contracts/src/contracts/lib/ProofLib.sol`
- `packages/sdk/src/types/withdrawal.ts` (`WITHDRAW_L1_SIGNALS`)
- `packages/relayer/src/utils.ts` (`parseSignals` now consumes the SDK constant instead of
  re-hardcoding indices — re-hardcoding is how it spread)

**Now guarded by** `packages/sdk/test/unit/withdrawalSignals.spec.ts`, which reconciles **four**
independently-produced sources: the generated verifier (`nPublic`, from the proving key), the circuit
`.sym` (signal order), `ProofLib.sol`, and the SDK map. Verified to fail when the bug is reintroduced.

> ⚠️ **Deployment blocker.** `ProofLib` is a library **inlined into `PrivacyPool` bytecode**, and the
> deployed Sepolia pool (`0x98657a…b3a2`) carries the old accessors. `PrivacyPool` is **not** behind a
> proxy (only `Entrypoint` is). **The pool must be redeployed.** No client-side change can reach it.

---

## 2. The frontend's withdraw flow had never run

**Severity: critical.**

`app/package.json` pinned `"@0xbow/privacy-pools-core-sdk": "1.2.0"` — the **published npm package**,
not the workspace SDK. Because the local SDK is *also* versioned `1.2.0`, it silently resolved to the
registry copy: same version string, completely different code.

Every Mode-3 API the withdraw flow calls was **absent** from that package:

```
hashPrecommitment        PRESENT   ← why deposits worked
proveWithdrawalL1        MISSING
NoteService              MISSING
buildDestNote            MISSING
stealthPrivKey           MISSING
calculateRelayContext    MISSING
encodeL2RelayData        MISSING
computeSharedSecretX     MISSING
```

The flow died instantly at `new NoteService()`. Deposits worked, so the app *looked* alive.

Worse, it was half-wired: the server served circuit **artifacts** from the *local* SDK (via the root
symlink) while the browser bundle imported the *published* one.

**Fixed** by repointing to the workspace SDK via yarn's `link:` protocol.

---

## 3. The sender was being asked for the recipient's private keys

**Severity: high — a modeling error, not a typo.**

The send form literally had:

```
RECIPIENT PRIVATE SPEND SECRET b
RECIPIENT PRIVATE VIEW SECRET  v
```

Mode 3's primitive is the **third-party send**, where the sender may only ever know `(B, V)`. The UI
had collapsed sender and recipient into one person — which is the *self-bridge* case. CLAUDE.md §9
defines self-bridge as a **special case of** the third-party send; the app had it exactly backwards,
encoding the special case as the general one.

That is also *why* the two-step withdrawal was squashed onto one screen: it was built for an actor who
holds both keypairs.

**Fixed** by splitting the UI into three screens matching the three real roles:

- **DEPOSIT** — put value into the L1 pool.
- **SEND** — public `(B, V)` only. `runSend` now has **zero** references to private-key state.
- **RECEIVE** — the only place private keys exist. Finds notes by **scanning**; the sender tells it
  nothing.

Self-bridge still works (send to your own address), and the on-chain footprint stays byte-identical,
as §9 requires — the divergence lives only in which screen you're on.

---

## 4. The L1 relay publicly leaked the recipient's exit address

**Severity: high — a privacy hole in a privacy protocol.**

`RelayData.recipient` is emitted on L1 in the public `WithdrawalRelayed` event. The sender was putting
the **recipient's final L2 cash-out address** in it — publicly linking the L1 relay to the L2 exit.

**Fixed.** That field now carries the *sender's own* address. The real destination is chosen by the
recipient, on the RECEIVE screen, at withdraw time — which is the only party entitled to choose it.

---

## 5. `getWithdrawals()` returned an empty array. Forever.

**Severity: high. Silent.**

`DataService`'s `Withdrawn` ABI still had the **pre-Mode-3 shape**:

```
indexer:   Withdrawn(address indexed _processooor, uint256, uint256, uint256)
contract:  Withdrawn(uint256, uint256, uint256, uint256)
```

Different parameter *types* → different `topic0` → **`getLogs` matched nothing**. The getter returned
`[]` on every call, with no error.

**Blast radius.** `AccountService` reconstructs spent state from these events, so **the SDK was
treating spent notes as unspent.** `/api/activity` read it too.

**Fixed** in `packages/sdk/src/core/data.service.ts` and `types/events.ts` (`WithdrawalEvent` now also
carries `newCommitmentL2`, the bridged `C_dest`; `newCommitment` is the L1 change note — the leaf
actually inserted into the L1 tree).

---

## 6. The `Deposited` event decoded correctly *by accident*

**Severity: high, latent. This one sat directly under note recovery.**

The indexer's ABI named the 5th field `_merkleRoot`. The contract emits `_precommitmentHash`.

It worked only because **`topic0` hashes parameter TYPES, not names** — the signature still matched and
the position happened to line up. viem then keys decoded args *by name*, and the code aliased
`_merkleRoot: precommitment`.

Mnemonic-based note recovery matches derived precommitments against **exactly this field**. A
well-meaning rename in one file and **recovery silently breaks** — no error, no failing test, users
simply cannot recover their notes.

**Fixed** — renamed to match the contract.

**Validated against the live chain**: 713 real `Deposited` logs from Sepolia, and **every one**
satisfies `Poseidon(value, label, precommitment) === commitment`. That is cryptographic proof the 5th
field really is the precommitment.

---

## 7. The indexer had no coverage at all

`data.service.spec.ts` is `describe.skipIf(!HYPERSYNC_API_KEY)` and points at pool `0xbbe3b0…`, which
is **not the deployed pool**. It requires an API key and a live network. **It has never run.**

That is how §5 and §6 both shipped.

**Now guarded by:**

- `packages/sdk/test/unit/eventAbis.spec.ts` — reads the Solidity interface **and** the indexer's own
  `parseAbiItem` strings **from source**, and asserts names, order and `topic0` all agree. It also
  pins the two failure modes explicitly:
  - a **type** change breaks `topic0` (→ matches nothing);
  - a **name-only** change leaves `topic0` identical — *which is why `topic0` parity alone is not
    sufficient*, and why §6 survived.
- `packages/sdk/test/unit/depositEvent.spec.ts` — a real encoded log round-trips into a note the
  mnemonic actually recovers.
- `packages/sdk/test/unit/data.service.offline.spec.ts` — decode path, the scan join
  (`buildScannableNotes`), and tree reconstruction (`reconstructL2StateTree`), all without a network.

---

## 8. `yarn check-types` had never passed

The SDK's `check-types` script **existed and failed**. `yarn build` (rollup) only *warns* on type
errors, so the build stayed green while the typecheck was broken and nobody ran it.

**Fixed** (`noUncheckedIndexedAccess` violations in `poseidonFold`). The SDK now typechecks clean.

It immediately earned its keep: it caught three construction sites when `WithdrawalEvent` gained
`newCommitmentL2`.

---

## 9. `/api/activity` had been 502-ing since it was written

Indexer events are full of `bigint`s, and **`JSON.stringify` throws on a bigint** rather than coercing
it. The handler spread raw events into `res.json`, blew up *inside its own try-block*, and returned a
502. The frontend swallowed it silently.

**Fixed** with a bigint-safe `sendJson` serializer.

---

## 10. Note recovery was O(all deposits) on every request

`GET /api/l1/deposits` replayed the pool's entire log history per call — and the deposit flow polls it.

**Fixed** with an incremental block-cursor cache:

- cursor tracks the **chain head minus a 16-block reorg buffer** — not "the last block that happened
  to contain a deposit", which would make a quiet pool re-scan the same range forever;
- dedupes on **precommitment** (unique by construction — the pool rejects reuse);
- collapses concurrent callers onto one in-flight refresh;
- `?refresh=1` forces a full replay.

Measured: cold **3.8s** → warm **1.2s**.

---

## 11. One mnemonic is now the root of the identity

Previously: L1 note secrets came from `randomField()` (pure local entropy, **not recoverable**), the
shielded keys were **typed in by hand**, and the vault was encrypted with a **wallet signature**.

Now everything derives from one phrase:

| Derived | HD account |
|---|---|
| `masterNullifier`, `masterSecret` (L1 note secrets) | 0, 1 — already existed |
| `b`, `v` (shielded spend + view keys) | 2, 3 — new |
| vault encryption key | 4 — new |

**Nothing is derived from a wallet signature.** Signatures are only deterministic for RFC-6979 signers;
plenty of smart-contract wallets and WalletConnect implementations are not. A signature that comes
back different once would mean **keys that can never be re-derived**. A wallet (or a password) may
*unwrap* the stored mnemonic, but it is never the source of a key — so a wallet change or a flaky
signer is recoverable, not fatal. The password path also lets a pure recipient use RECEIVE **with no
EOA at all**, which is the point of a stealth address.

**The consequence that matters:** deposit secrets are `Poseidon(master, scope, index)`, so notes are
**re-derivable**. `recoverNotes()` rebuilds every L1 note from the mnemonic plus public `Deposited`
events. **The vault stopped being the source of truth and became a cache.** Before this, losing
`localStorage` lost your funds, permanently.

Deposit indices come from **chain state, not a local counter** — two devices sharing a mnemonic would
otherwise derive the same precommitment and the second deposit would revert `PrecommitmentAlreadyUsed`.
A BIP-44-style gap limit means one reverted deposit doesn't hide every note after it.

Legacy (pre-mnemonic) notes are **not** re-derivable; both historical vault messages are tried on
unlock and those notes are migrated into the new vault.

New: `packages/sdk/src/identity.ts`, `app/src/vault.js`, `packages/sdk/test/unit/identity.spec.ts`.

---

## 12. Publishing `(B, V)` — to the right contract

The obvious target, `0x5564…5564`, is the ERC-5564 **Announcer**. Its bytecode exposes exactly one
function, `announce()`. **You cannot publish a meta-address there** — announcing is for per-payment
ephemeral keys.

Meta-addresses live in the ERC-**6538** Registry, `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538`
(verified live on Sepolia with `registerKeys`, `registerKeysOnBehalf`, `stealthMetaAddressOf`).

**Registered under a domain-separated `schemeId`, never `1`.** SchemeId 1 means secp256k1 + keccak,
where the stealth address is a real Ethereum address in the value path. Ours is Baby Jubjub + Poseidon
and `P` is never an address at all. Registering our blob under schemeId 1 would make a conformant
ERC-5564 wallet parse it as secp256k1 keys and **send real funds to a garbage address**. A distinct id
keeps conformant tooling correctly ignoring us (CLAUDE.md §2).

The **Announcer is deliberately unused**: Mode 3 already carries `E` in the note message (§10), so
announcing would be redundant *and* create a second correlatable surface.

---

## 13. Scanning: the view tag is a client-side optimisation, not a query filter

The relayer serves the **whole** note feed; matching happens entirely in the browser.

Asking the relayer for *"notes with view tag `0x07`"* would hand it a **1-in-256 fingerprint** of the
recipient and tie an IP to a note set. The view tag exists to skip the `v·E` scalar mult for ~255/256
of notes — that's a CPU optimisation on the client, not a server-side filter. Easy mistake; it quietly
guts the anonymity set.

---

## 14. Starknet finalization

Garaga calldata used to be a **manual step**: the UI made the recipient run the `garaga` **Python CLI**
and paste a felt array into a textarea.

Garaga publishes the same logic as a **WASM package at the same version**, so `/api/starknet/calldata`
does the conversion server-side and the recipient never sees it. Proven end-to-end: a real, verified
`withdrawL2` proof → **1992 felts, generated in JS**.

`/api/starknet/index` joins the L1 `L2Note` deliveries (which carry `E` + view tag regardless of
destination) with the Cairo pool's `NoteReceived`/`NoteActivated` events, so Starknet notes are
scannable exactly like OP-Stack ones.

**The destination is fail-closed.** The Cairo pool's `l1_pool` is **immutable**, set in its
constructor. If it is not bound to *our* L1 pool, a relay is a **trap**: StarkGate still delivers the
ETH, but the note message reverts `NotL1Pool` — the value lands with **no note that can ever claim
it**. Unrecoverable.

So `/api/starknet/config` reads the binding from storage (`sn_keccak("l1_pool")`), and `configured`
requires `l1PoolMatches === true`. A binding that cannot be read, or does not match, **disables
Starknet in the UI** rather than risking the loss.

---

## 15. Smaller fixes

- **Relay fee read from the wrong place.** The app recomputed `bridgedValue` from `quote.feeBPS` with
  a silent `?? 0` fallback, while the relayer validates against the `relayFeeBPS` **embedded in the
  signed `withdrawalData`**. Two sources of truth; if they ever diverge, every relay is rejected. Now
  decoded from the signed bytes — the same bytes the proof context binds.
- **Errors were invisible.** Failures were written into the action button's label and discarded by the
  next render, so a failed relay looked like nothing happened. Now a persistent error banner, with
  form state preserved across failures (an error used to wipe everything the user had typed).
- **The relayer's integration CLI was dead code** — it called `sdk.proveWithdrawal`, which Mode-3
  turned into an unconditional throw. Ported to the split `proveWithdrawalL1` API.
- **The L2 spend has its own fee**, not the L1 relay's. The recipient sets it; the L2 relayer submits.

---

## 16. The frontend showed spent notes as spendable

**Severity: high. Silent until the relayer rejected the spend.**

A note's `status: "spent"` was a **write-only local cache**. It only flipped after a successful relay
in the *same* browser session (`runSend`); nothing ever reconciled it against the chain. So a note
spent on another device — or rebuilt by RECOVER, which walks public deposits and *cannot tell a spent
note from a live one*, defaulting every rebuilt note to `ready` — or lost to a persistence race across
a tab reload, stayed `ready`. `pickNote` offered it, the client built a **valid** proof against a live
historical root, and the L1 pool's `relay()` was the *first* thing to catch it: `NullifierAlreadySpent()`.

The on-chain truth was available the whole time: the pool's public `nullifierHashes(uint256)` mapping,
and the `Withdrawn` event's `_spentNullifier` — which is `existingNullifierHash` = `Poseidon([nullifier])`,
single-input, per `commitmentL1.circom`. The frontend simply never asked.

**Fixed** — the client reconciles against the chain instead of trusting local state:

- server: `GET /api/l1/spent-nullifiers` sweeps `Withdrawn` events (reusing the incremental
  `createLogCache`) and returns the burned nullifier-hash set;
- client: `reconcileSpentNotes()` marks any local note whose `poseidon1([nullifier])` is in that set as
  spent — wired into `afterUnlock` (non-blocking, re-renders on a change), `recoverL1Notes` (recovery
  no longer resurrects spent notes as `ready`), and a pre-spend guard in `runSend` (bails with a clear
  message rather than surfacing the raw revert);
- `poseidon-lite/poseidon1` on the client — browser-native (no Node deps), and verified byte-identical
  to the circuit/SDK Poseidon.

**Best-effort by design.** The sweep is only as complete as the RPC's `eth_getLogs` history, and a
failed sweep leaves the cache untouched — degrading to "the relayer is the backstop", never to a false
`ready`. `app/server/index.mjs`, `app/src/main.js`.

---

## 17. Starknet showed "DISABLED — unreachable" on a healthy pool

**Severity: medium. Intermittent, and it masked a real config trap.**

`/api/starknet/config` reads the immutable `l1_pool` binding from storage to decide whether Starknet is
safe to send to (§14). That read was **one-shot with no retry**: a single failure left
`l1PoolMatches = null`, which the UI renders as the generic "unreachable" — even though the binding
actually *matched* (`POOL_ADDRESS` == the pool's `l1_pool`, both `0xf913ab5e…`). The trigger was
Infura's `-32603 service temporarily unavailable` blips.

Two entangled facts made this confusing to diagnose:

- **Infura Starknet serves JSON-RPC spec 0.8.1; Alchemy v0.10 serves 0.10.3.** The app runs
  starknet.js 6.x, which speaks 0.8.x — so the *app runtime* must stay on Infura. Alchemy is for the
  Cairo *deploy* tooling (sncast demands 0.10.x). They are deliberately different nodes; "unifying"
  them breaks the write path.
- Alchemy additionally rejects the default `pending` block tag in `getStorageAt` with
  `-32602 Invalid block id`, so naively "switch to Alchemy" swaps one failure for another.

**Fixed** in `getStarknetBoundL1Pool` (`app/server/index.mjs`): wrap the read in the existing
`withRetry` so a transient blip no longer fail-closes the destination, and pin the query to `latest`
(the slot is immutable, so `latest` == `pending`, and `latest` works on every provider). Runtime
`STARKNET_RPC_URL` kept on Infura.

---

## 18. Every Starknet withdrawal reverted — the relay never paid the bridge fee

**Severity: critical for Starknet/Arbitrum. OP-Stack unaffected — which is exactly why it hid.**

The SDK's `relay()` simulated the pool call with **no `value`**, so `msg.value = 0` on every relay. The
pool fronts the canonical bridge's L1→L2 message fee out of `msg.value` (`PrivacyPool._bridge`), and the
requirement diverges by bridge family:

| `BridgeKind` | required `msg.value` |
|---|---|
| OpStack | **0** — the note rides on L1-derived gas (so Base/Optimism relays worked) |
| Starknet | `messageFee + tokenFee` — StarkGate charges a flat ETH fee for *each* of the two L1→L2 messages (note message + token deposit) |
| Arbitrum | submission + L2 gas (`messageFee + messageGasLimit·messageMaxFeePerGas`), plus a token leg for ERC20 |

With 0 attached, `_bridgeStarknet` reverted `InsufficientBridgeFee()`. Measured on Starknet Sepolia:
`messageFee + tokenFee = 0.0002 ETH` required; the relay fee earned from the note (~0.00073 ETH) covers
it — so it was never an economics problem, the ETH simply wasn't sent.

**Fixed** in `packages/sdk/src/core/contracts.service.ts`: a new `bridgeMsgValue()` reads
`Entrypoint.getBridgeConfig(chainId, asset)` and computes the exact `msg.value` mirroring `_bridge` per
`BridgeKind`; `relay()` attaches it. The deprecated `withdraw()` alias — which carried the identical
latent bug — now delegates to `relay()` rather than duplicating (and drifting from) it. The relayer
runs the local workspace SDK (`node_modules/@0xbow/privacy-pools-core-sdk` → symlink), so the SDK was
rebuilt; JS only, with the circuit `artifacts/` restored byte-identical so the deployed verifier keys
are untouched.

**Follow-up (open).** The relayer's *quote* logic should ensure the quoted relay fee ≥ bridge fee + gas
for Starknet/Arbitrum, or a small withdrawal could be quoted a fee below the 0.0002 ETH the relayer now
fronts from its own balance.

---

## Deployment blockers

1. **Redeploy the Sepolia L1 pool.** (See §1.) `ProofLib` is inlined into `PrivacyPool` bytecode and
   the deployed pool carries the broken accessors. It is not behind a proxy.
2. **A Starknet Cairo pool bound to this L1 pool must be deployed**, and `STARKNET_RPC_URL` /
   `STARKNET_RELAYER_ADDRESS` / `STARKNET_RELAYER_PRIVATE_KEY` filled in, before Starknet can be
   enabled. Until then it is correctly disabled.
3. `RELAYER_PRIVATE_KEY` must be the funded testnet relayer key, or the relayer falls back to the
   development Anvil key.

---

## Not verified

Stated plainly, because "it compiles" is not "it works":

- **The Starknet path has never been exercised end to end.** The env vars are empty and public
  Starknet RPCs were unreachable from the dev environment, so the `l1_pool` binding could not be read
  and no call was made against a live pool. *The calldata conversion is proven; the chain interaction
  is not.* The gate is fail-closed, so this is safe by default — but the honest status is **"correctly
  disabled," not "working."**
- **The §18 bridge-fee fix is confirmed against the on-chain config, not against a live relay.** The
  required `msg.value` (0.0002 ETH for Starknet Sepolia) was read from `getBridgeConfig` and the branch
  math mirrors `_bridge`, but a fresh withdrawal proof (unused nullifier) can only be produced by the
  app flow — so the actual `InsufficientBridgeFee` clear must still be observed with a real Starknet
  relay. Restart the relayer first (it loads the SDK at startup).
- **The relayer's integration CLI** is ported and typechecks, but needs a live chain plus a running
  relayer to execute. It has not been run.
- **`data.service.spec.ts` still never runs.** Its decode/scan/tree paths are now covered offline, but
  that file should be repointed at the live pool or deleted, rather than sitting there looking like
  coverage.

---

## Test status

| Package | Result |
|---|---|
| SDK | 200 passed, 5 skipped · **typecheck clean** (it had never passed) |
| Relayer | 15 passed, 1 skipped · typecheck clean |
| Contracts | production build passing |
| App | syntax + production build passing |

---

## The one rule to keep

**Never re-derive a layout by hand.**

Public-signal indices, event ABIs, package versions — every one of them has a single source of truth
(the circuit, the Solidity interface, the workspace). Read from it. If you must keep a copy, pin the
copy to the source with a test that reads **both sides from disk**.

A test that compares two hand-written copies passes happily while the protocol is dead. That is not a
hypothetical: it is precisely what happened here, and every withdrawal reverted for it.

# Cutout / F5 — Deployment & Run Runbook

> **For the happy path, use [`DEPLOYMENT.md`](./DEPLOYMENT.md).** It is the clean, current
> deployment guide and its addresses are the ones verified on-chain. This runbook is kept as a
> troubleshooting appendix (indexing/caching internals, the verifier-consistency incident, signer
> resolution) and contains older, superseded address sets — where the two disagree, trust the
> deploy records and `ops/check-deployment.sh`, not the prose here.

How the whole system is deployed and run end-to-end (L1 pool → OP/Base/Starknet
destinations → relayer + ASP → the Vault app), plus the **current deployed
addresses** and the **consistency issues that block cross-chain today**.

Last verified: 2026-07-17 (Sepolia testnet). **Deployment generation v2** — see §2.

---

## 0. TL;DR — current status

**All three destinations are reconciled on-chain against the canonical L1 `0xf913ab5e…`.** Every
Entrypoint bridge config points at a pool whose immutable `L1_POOL` / `l1_pool` is that L1. The
cross-chain fragmentation described in §2 is **resolved**; what remains is funding and app wiring.

| Leg | Contracts (on-chain) | Backend | Working now? |
| --- | --- | --- | --- |
| **Deposit (L1)** | ✅ deployed | ✅ app reads live config + indexes | ✅ **yes** |
| **Send (L1 relay + ASP)** | ✅ | ✅ relayer serves proofs; **ASP root published on-chain** | ✅ **yes** |
| **Withdraw → OP** | ✅ pool `0x8EDa42e5…` + bridge config, verifier regenerated (§9) | ✅ `configured: true` | ✅ **yes** |
| **Withdraw → Base** | ✅ pool `0x37ac59BE…` + bridge config, verifier regenerated (§9) | ✅ `configured: true` | ✅ **yes** |
| **Withdraw → Starknet** | ✅ pool `0x06c3fa5e…` + bridge config | ✅ `configured: true`, `l1PoolMatches: true` | ✅ **yes** |

Verified 2026-07-17: `/api/config` advertises `['op','base']`; all three destination configs report
`configured: true`; `Entrypoint.latestRoot()` equals the relayer's ASP tree root
(`836564038118778419351594…`), so `IncorrectASPRoot` no longer applies.

The stale-`L2WithdrawalVerifier` problem (§9) is **resolved**: the verifier was regenerated from the
authoritative zkey and the OP + Base pools were redeployed against it, with their Entrypoint bridge
configs re-pointed. Circuit artifacts are staged (`yarn present`) and served — all 9 return HTTP 200.

**Base was never broken.** It was deployed and bridge-configured on-chain the whole time; it was
simply absent from `app/.env` (`BASE_POOL_ADDRESS` empty, `base` missing from `L2_EVM_CHAINS`), so
the app never advertised it. Deploying a destination and *exposing* it to the app are two steps.

---

## 1. Architecture recap

One canonical L1 Privacy Pool. Every withdrawal is Mode-3: spend an L1 note,
canonically bridge its value to a destination L2/Starknet shielded pool, and
deliver a stealth commitment there. A destination pool **immutably binds one L1
pool** (`L1_POOL` on the L2 pool; `l1_pool` on the Cairo pool) and rejects notes
from any other. **Therefore all destinations must bind the same canonical L1
pool, or bridging silently loses value** (ETH arrives, note is rejected).

---

## 2. Deployed addresses (Sepolia) — and the consistency problem

There are **three different L1 pools** in play across the records. They are not
interchangeable because destination bindings are immutable.

### Set A — current app/relayer L1 (canonical target) — **v2**
Source: `packages/contracts/deployments/11155111.json`, `app/.env`,
`packages/relayer/config.sepolia.json`.

| Contract | Address | Block |
| --- | --- | --- |
| Entrypoint (proxy) | `0x4113f1b88fecc9097303ac011d03335979e7ba9f` | 11287653 |
| Entrypoint (impl) | `0xc2383cc46e63199da1c92257bda34fea15a135e0` | 11287653 |
| PrivacyPool_ETH (L1) | `0xf913ab5e2b0dd32ba2ff4969962919834f954c10` | 11287653 |
| WithdrawalVerifier | `0x2cace6cccd41cc52b791802e6b5c5452c46f6bd4` | 11287653 |
| CommitmentVerifier (ragequit) | `0x53bb74d106dfa76032013d6f8e72d106d7dfb478` | 11287653 |
| SCOPE | `1055517827990082386284916754464518897846781813533358671393655482931018891549` | |

Deployed with `DEPLOYMENT_VERSION=2` (v0 and v1 salts are already consumed on Sepolia; reusing one
fails with CreateX `FailedContractCreation`). **This is the L1 everything else binds to.**

> **Why v2 exists:** the v1 pool `0x98657a…` shipped a stale `ProofLib` and could not verify ANY
> withdrawal — see §9. Its deposits are stranded; that is accepted (testnet dust).

### Set B — OP L2 pool (REDEPLOYED, now bound to the canonical L1) ✅
Source: `deployments/11155420.json` (post-rebind).

| Contract | Address | Notes |
| --- | --- | --- |
| L2PrivacyPool (OP Sepolia) | `0x002f4910DDFA5d081c3612fc88d8AF9F92Cd97A2` | `L1_POOL = 0xf913AB5e…` ✅ block 46219109 |
| L2WithdrawalVerifier | `0x319413d62896b35C94EF344B2ca298e8F7fa91aA` | ✅ regenerated key (§9) |

The OP pool was redeployed bound to the canonical L1 `0xf913ab5e…` and the
Entrypoint's OP bridge config re-pointed at it. `app/.env` uses this address
(`OP_POOL_ADDRESS`). Superseded OP pools: `0xfbba1f…` (stale L1 `0x8D508e…`) and `0xfA1B3a…`
(correct L1, but stale verifier — §9).

### Set C — Base L2 pool (bound to the canonical L1) ✅
Source: `deployments/84532.json`.

| Contract | Address | Notes |
| --- | --- | --- |
| L2PrivacyPool (Base Sepolia) | `0xeEEd6485A583D197F2F5805AdE7Ec6ECBcDA833D` | `L1_POOL = 0xf913AB5e…` ✅ block 44247229 |
| L2WithdrawalVerifier | `0x8A84d7eCd2d435ddAe13522eEed387bF13a22CB0` | ✅ regenerated key (§9) |

Deployed, bridge-configured, and wired into `app/.env` (`BASE_*` + `base` in `L2_EVM_CHAINS`).
Superseded Base pool: `0x320c4C5e…` (correct L1, stale verifier — §9).

### Set D — Starknet (REDEPLOYED, bound to the canonical L1) ✅
Source: `packages/starknet-pool/deployments/starknet-0x534e5f5345504f4c4941.json`
(note: the sncast deploy writes **here**, not to `packages/contracts/deployments/`).

| Contract | Address |
| --- | --- |
| Cairo pool | `0x053cc08c203ce5935aeef9674a1afcff74bc4d7acc69e9a1146f9b14df8647a0` |
| Cairo pool `l1_pool` bound to | `0xf913ab5e…` ✅ |
| Cairo verifier | `0x0605d599d6c650bc93f60a0ebc4075e1c968f300645b50d27e3b8ed8fd6091e3` |
| Starknet Core (L1) | `0xE2Bb56ee936fd6433DC0F6e7e3b8365C906AA057` |
| StarkGate ETH bridge (L1) | `0x8453FC6Cd1bCfE8D4dFC069C400B433054d47bDc` |
| L2 ETH asset (felt) | `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7` |

The class hashes were already declared from the earlier deploy, so this was a fresh **instance**
against the existing classes (no re-declare — Starknet rejects that, and it is not an error).

**Retired sets** (do not reuse — bound to L1 pools that are no longer canonical). The two stale
JSON records — `deployments/starknet-bridge-sepolia.json` (Cairo pool `0x07b336…` → L1 `0x2e302A…`,
entrypoint `0xfA1B3a…`) and `packages/starknet-pool/deployments/starknet-sepolia.json` (pool
`0x01ff6476…` → `l1_pool: 0xdeadbeef`, a literal placeholder) — were **removed on 2026-07-17**;
their addresses are preserved here as history only. The superseded OP pool `0xfbba1f…` → L1
`0x8D508e…` never had its own record file. These are why the state fragmented.

> **Reusable regardless of L1:** Starknet Core `0xE2Bb56…`, StarkGate ETH bridge
> `0x8453FC…`, and the OP Stack addresses (§4) — these are network infrastructure,
> not per-deployment.

---

## 3. The fix — reconcile everything onto one canonical L1

Pick **Set A** (`0x98657a` / entrypoint `0xbac21b`) as canonical (it's what the
app + relayer already use). Then rebuild each destination against it.

> Each yarn alias below sets `L2_TARGET` itself (and picks the matching RPC), so
> you do **not** edit `L2_TARGET` in `.env` — just fill the relevant `<PREFIX>_*`
> block. Only `<PREFIX>_L2_POOL_ADDRESS` (emitted by the deploy) is filled between
> the two steps.

### 3a. OP Sepolia
```bash
cd packages/contracts
# .env: L1_POOL_ADDRESS=0x98657a…, OP_SEPOLIA_* filled
yarn deploy:l2:op-sepolia --broadcast          # deploys L2 pool bound to 0x98657a
# set OP_SEPOLIA_L2_POOL_ADDRESS to the emitted address, then:
yarn configure:bridge:op-sepolia --broadcast   # re-point entrypoint at the new L2 pool
```
Update `app/.env` `OP_POOL_ADDRESS` + `OP_DEPLOYMENT_BLOCK` to the new pool.

### 3b. Base Sepolia (same scripts, different prefix)
```bash
# .env: BASE_SEPOLIA_* filled (see .env.testnet.example)
yarn deploy:l2:base-sepolia --broadcast
# set BASE_SEPOLIA_L2_POOL_ADDRESS, then:
yarn configure:bridge:base-sepolia --broadcast
```
Verify the Base Sepolia L1 messenger/bridge addresses before broadcasting.

### 3c. Starknet Sepolia

The Cairo pool is deployed with `sncast` (not Foundry). Its inputs live in
`packages/starknet-pool/.env` (see `.env.example` there); the script sources it.

```bash
# 1. Deploy the Cairo pool + verifier, bound to the canonical L1.
#    l1_pool is IMMUTABLE — bind it to 0x98657a or receive_note rejects every note.
cd packages/starknet-pool
#    .env: SN_ACCOUNT=sn2, SN_RPC=<starknet sepolia rpc>,
#          L1_POOL_ADDRESS=0x98657a…, SN_ASSET_ADDRESS=0x049d36…
./deploy/deploy-starknet.sh      # prints: DEPLOYED verifier=0x… pool=0x…

# 2. Put the printed pool address in packages/contracts/.env as
#    STARKNET_SEPOLIA_L2_POOL_FELT. (Core, StarkGate and the receive_note
#    selector are already filled there.)
cd ../contracts
yarn configure:bridge:starknet-sepolia --broadcast   # NEW script (this repo)
```

`STARKNET_SEPOLIA_L1_HANDLER_SELECTOR` = `sn_keccak("receive_note")` =
`0xafb78720fe8e7dad4e1079e5a4a9ca568567c1eaad64c3c662ef968d138664` (fixed for this
handler name; recompute only if the handler is renamed).

> **Starknet RPC: the deploy and the app need DIFFERENT nodes.** They pin
> incompatible JSON-RPC spec versions, and each hard-fails on the other's endpoint:
>
> | Consumer | Needs spec | Use |
> | --- | --- | --- |
> | `sncast` 0.57 (Cairo deploy, `SN_RPC`) | 0.10.x | `https://api.zan.top/public/starknet-sepolia/rpc/v0_10` |
> | starknet.js 6.x (app, `STARKNET_RPC_URL`) | 0.8.x | `https://starknet-sepolia.infura.io/v3/<key>` |
>
> Infura serves 0.8.1 → sncast refuses it ("incompatible version 0.8.1. Expected
> version: 0.10.0"). ZAN serves 0.10.3 → starknet.js 6.x fails against it. A
> `starknet_chainId` curl succeeds on both and will NOT catch this — verify with the
> actual tool. Don't try to unify the two.
Point `app/.env` `STARKNET_POOL_ADDRESS` at the new Cairo pool and set
`STARKNET_RPC_URL`, `STARKNET_RELAYER_ADDRESS`, `STARKNET_RELAYER_PRIVATE_KEY`.

> `configure:bridge:starknet-sepolia` was the missing piece: without a Starknet
> `BridgeConfig`, the pool's `_bridgeStarknet` path reverts `UnsupportedChain`.
> The script is verified to simulate against the live Entrypoint.

---

## 4. Network infrastructure addresses (reusable)

| Chain | L2 messenger (predeploy) | L1 messenger | L1 standard bridge | Chain id |
| --- | --- | --- | --- | --- |
| OP Sepolia | `0x4200…0007` | `0x58Cc85b8D04EA49cC6DBd3CbFFd00B4B8D6cb3ef` | `0xFBb0621E0B23b5478B630BD55a5f21f67730B0F1` | 11155420 |
| Base Sepolia | `0x4200…0007` | `0xC34855F4De64F1840e5686e64278da901e261f20` | `0xfd0Bf71F60660E2f608ed56e1659C450eB113120` | 84532 |

| Starknet Sepolia | Value |
| --- | --- |
| Starknet Core (L1) | `0xE2Bb56ee936fd6433DC0F6e7e3b8365C906AA057` |
| StarkGate ETH bridge (L1) | `0x8453FC6Cd1bCfE8D4dFC069C400B433054d47bDc` |
| Chain id (felt, `SN_SEPOLIA`) | `393402133025997798000961` |
| `l1_handler` selector | `starkli selector receive_note` |

(Base L1 addresses to be re-verified against the current Base Sepolia deployment
before mainnet-money use.)

---

## 5. Services & ports

| Service | Command (from repo root) | Port | Serves |
| --- | --- | --- | --- |
| App API + client | `cd app && yarn dev` | 8787 (+ Vite) | `/api/*`, the Vault UI |
| Relayer + testnet ASP | `cd packages/relayer && CONFIG_PATH=./config.sepolia.json yarn start:ts` | 8788 | `/relayer/quote`, `/relayer/request`, `/relayer/asp/proof/:label` |

The app server proxies `/api/relayer/*` → `RELAYER_API_URL` and, when `ASP_API_URL`
is empty, `/api/asp/proof/:label` → `RELAYER_API_URL/relayer/asp/proof/:label`.
**One running relayer covers both the "relayer" and "ASP" flags.**

Build note: the relayer can run from TypeScript directly (`start:ts`) or built
(`yarn build && CONFIG_PATH=./config.sepolia.json yarn start`).

---

## 6. Environment reference

### `app/.env` (deposit path fully wired; ⚠️ = still needed for send/withdraw)
| Var | Value / source |
| --- | --- |
| `CHAIN_ID` / `CHAIN_NAME` | `11155111` / `Sepolia` |
| `PUBLIC_RPC_URL` | Sepolia RPC |
| `POOL_ADDRESS` | `0x98657a…` (canonical L1 pool) |
| `POOL_SCOPE` | matches on-chain `SCOPE()` ✅ |
| `DEPLOYMENT_BLOCK` | `11265627` |
| `ENTRYPOINT_ADDRESS` | `0xbac21b…` |
| `RELAYER_API_URL` | `http://localhost:8788` ✅ |
| `ASP_API_URL` | empty → falls back to relayer's ASP ✅ |
| `L2_EVM_CHAINS` | comma list of EVM L2 keys, e.g. `op` (add `base` when filled) |
| `OP_CHAIN_ID` / `OP_CHAIN_NAME` / `OP_RPC_URL` | OP Sepolia |
| `OP_POOL_ADDRESS` / `OP_DEPLOYMENT_BLOCK` | `0xfA1B3a…` / `46208090` (rebound pool) |
| ⚠️ `OP_RELAYER_PRIVATE_KEY` | funded OP Sepolia account — activates + withdraws OP notes |
| `BASE_*` (same shape) | fill + add `base` to `L2_EVM_CHAINS` to enable Base |
| ⚠️ `STARKNET_RPC_URL` | Starknet Sepolia RPC |
| ⚠️ `STARKNET_RELAYER_ADDRESS` / `STARKNET_RELAYER_PRIVATE_KEY` | funded Starknet account |
| `STARKNET_POOL_ADDRESS` | Cairo pool (update after 3c) |

> **Per-chain, not one generic "L2".** The app server reads each EVM L2 by
> uppercased prefix (`OP_*`, `BASE_*`) and routes `/api/l2/:chain/*` accordingly;
> `/api/config` advertises the configured chains so the Vault scans and groups them
> separately. This replaces the old single `L2_*` block.

### `packages/relayer/` — env **and** JSON (two files, different jobs)

The relayer now loads `.env` via dotenv (`import "dotenv/config"` — **must be the first import** in
`src/index.ts`, because `config/index.ts` reads `CONFIG_PATH` at module-evaluation time and is
pulled in transitively by `./app.js`).

`packages/relayer/.env` — process knobs + secrets (gitignored):
| Var | Value |
| --- | --- |
| `CONFIG_PATH` | `./config.sepolia.json` (required; else it looks for `./config.json`) |
| `PORT` / `HOST` | `8788` / `0.0.0.0` |
| `TESTNET_ASP_MODE` | `true` — without it `/relayer/asp/proof/:label` 404s |
| `TESTNET_ASP_POLL_MS` | `10000` |
| `RELAYER_PRIVATE_KEY` | the L1 signer (overrides the JSON) |
| `RELAYER_FEE_RECEIVER_ADDRESS` | optional; else fees fall through to the signer |
| `LOG_CHUNK_BLOCKS` | optional; `eth_getLogs` window (default 9000) |

`packages/relayer/config.sepolia.json` — structured, non-secret config (tracked by git):
- `chains[0].entrypoint_address` = `0xbac21b…` ✅
- `chains[0].asp_pools[0]` = `{ pool_address: 0x98657a…, start_block: 11265627 }` ✅
- `defaults.signer_private_key` — **removed**; the key lives in `.env` (see §7)
- `defaults.fee_receiver_address` is `0x0000…`, so relay fees are paid to the signer

> `fee_receiver_address = 0x0000…` is not "no fee" — it makes `getFeeReceiverAddress` fall back to
> the signer's own address. Set `RELAYER_FEE_RECEIVER_ADDRESS` to direct fees elsewhere.

### `packages/contracts/.env` (deploy) — see `.env.testnet.example`
`DEPLOYER_ADDRESS` = `0x0eB4d30c…` (also owner + postman). `L2_TARGET` selects the
active destination for the deploy/configure scripts.

---

## 7. Signers & keys — who pays for what

There is **no single relayer key**. The L1 relay and each destination leg are submitted by
different processes with different keys, so a working end-to-end withdrawal needs **up to four
funded accounts**.

| Signer | Submits | Stored in | Funded with |
| --- | --- | --- | --- |
| **L1 relay** | the L1 withdrawal (`relay`), pays its gas, and publishes the ASP root (`updateRoot`) | **`packages/relayer/.env` → `RELAYER_PRIVATE_KEY`** | Sepolia ETH |
| **OP** | `activateNote` + `withdrawL2` on OP | `app/.env` → `OP_RELAYER_PRIVATE_KEY` | OP Sepolia ETH |
| **Base** | same, on Base | `app/.env` → `BASE_RELAYER_PRIVATE_KEY` | Base Sepolia ETH |
| **Starknet** `0x77488a3a…` (`sn2`) | `activate_note` + `withdraw` on Starknet | `app/.env` → `STARKNET_RELAYER_ADDRESS` + `STARKNET_RELAYER_PRIVATE_KEY` | Starknet Sepolia ETH |

**Current testnet setup:** all four roles are the deployer `0x0eB4d30c…`, which holds gas on
Sepolia / OP / Base and already has `ASP_POSTMAN`. Convenient, and it is what unblocked the ASP —
but it means the **relayer signer is also the protocol owner**. For mainnet, split these: a
compromised relayer key must not imply ownership. Grant the relayer only `ASP_POSTMAN`.

**Why the key is in `.env`, not the JSON:** `config.sepolia.json` is **tracked by git**, `.env` is
not. The schema originally marked `defaults.signer_private_key` *required*, which forced the secret
into version control — a live key is in this repo's history because of it (dead now: unfunded,
unused). `signer_private_key` is now optional; `getSignerPrivateKey` throws if neither env nor
config supplies one. Structured config (chains, RPCs, pools, fees) stays in the JSON because it is
nested and array-shaped; flat `.env` cannot express `chains[].supported_assets[].fee_bps`.

**The relayer has no L2 signers.** `web3Provider` builds one signer per entry in `CONFIG.chains`,
and `config.sepolia.json` declares only Sepolia — the relayer *only* does the L1 relay. The L2
legs are submitted by the **app server**, which passes `<PREFIX>_RELAYER_PRIVATE_KEY` into
`getSdk().createContractInstance(...)` from its per-chain registry. The relayer's config schema
*would* accept extra `chains[]` entries, but nothing there submits L2 transactions, so adding one
just creates an unused signer.

**L1 signer resolution order** (first wins): env `RELAYER_PRIVATE_KEY` / `RELAYER_SIGNER_PRIVATE_KEY`
→ `chains[].signer_private_key` → `defaults.signer_private_key`. The
`[CONFIG WARNING] Using default signer_private_key` line just means the `defaults` fallback is in use.

Consequences worth remembering:
- An **unfunded L1 signer** silently degrades the ASP: the label tree still builds in memory (so
  `/relayer/asp/proof` returns a proof), but `updateRoot` never lands, so the pool rejects the
  withdrawal with `IncorrectASPRoot`. Symptom: prove succeeds, submit fails.
- All keys are plaintext on disk (`.env` / `config.sepolia.json`); both are gitignored. The
  Starknet account's key lives in the sncast store (`~/.starknet_accounts/…`) and is copied into
  `app/.env` by hand.

### Publishing the ASP root needs BOTH gas and the role — RESOLVED ✅

The L1 signer must have Sepolia ETH **and** the `_ASP_POSTMAN` role
(`keccak256("ASP_POSTMAN")` = `0xfc84ade01695dae2ade01aa4226dc40bdceaf9d5dbd3bf8630b1dd5af195bbc5`,
= role id **1** in `AssignRole`). **Either one missing fails the publish** — funding a signer that
lacks the role just moves the error.

The original signer had *neither* (0 balance, `hasRole → false`); the Entrypoint was initialized
`initialize(owner, postman)` with the **deployer** as postman, so the relayer's own key was never
granted anything. Resolved by pointing `RELAYER_PRIVATE_KEY` at the deployer, which has both.
`Entrypoint.latestRoot()` now equals the relayer's tree root.

If you later split the roles (recommended for mainnet), the new signer needs both, in this order —
**rotate before funding**, never fund a key that has leaked:

```bash
cd packages/contracts && source .env
cast send <NEW_SIGNER> --value 0.05ether --account DEPLOYER --rpc-url $ETHEREUM_SEPOLIA_RPC
yarn assignrole:sepolia --broadcast     # prompts: account = <NEW_SIGNER>, role = 1
```

**Failure signature to recognise:** an unpublished ASP root does *not* break proving. The label tree
still builds in memory, so `/relayer/asp/proof` happily returns a proof — the withdrawal then
reverts on-chain with `IncorrectASPRoot`. Symptom: **prove succeeds, submit fails.** Check
`Entrypoint.latestRoot()` against the relayer's proof root before debugging anything else.

### One signer resolution path

`getSignerPrivateKey(chainId)` is the single source of truth (env → `chains[].signer_private_key` →
`defaults.signer_private_key`). `sdk.provider.ts` previously read the config **directly**, bypassing
it — so with `RELAYER_PRIVATE_KEY` set, the SDK and `web3Provider` would have signed with two
DIFFERENT accounts in one process. Both now go through the helper; keep it that way.

> `assignrole:sepolia` / `updateroot:sepolia` previously referenced `$SEPOLIA_DEPLOYER_NAME`,
> `$SEPOLIA_RPC`, `$SEPOLIA_POSTMAN` — none of which exist in this `.env`, so they resolved to an
> empty `--account`/`--rpc-url`. They now use `DEPLOYER` + `$ETHEREUM_SEPOLIA_RPC`.

## 8. Indexing: RPC limits, chunking and caching

Two RPC realities shape all historical reads, and both have already caused outages here:

**Block-range caps.** Infura rejects `eth_getLogs` over >10k blocks
(`range N exceeds limit of 10000`). A deployment-block→`latest` sweep is a **time bomb**: it works
for the first ~10k blocks after deploy, then fails forever. Every historical sweep is chunked into
`LOG_CHUNK_BLOCKS` (default **9000**) windows, **serially** — firing all windows at once trips rate
limits (`-32603 service temporarily unavailable`). Both paths retry with backoff (4 attempts,
500ms→4s).

**Caching.** Replaying a pool's whole history per request does not survive contact with a real
pool. Three incremental caches follow the same shape — accumulate logs, fetch only *forward* from a
cursor, collapse concurrent callers onto one refresh:

| Cache | Where | Persistence |
| --- | --- | --- |
| `depositCache` (`Deposited`) | `app/server/index.mjs` | in-memory |
| `readLeafLogs` (`LeafInserted`, state proof) | `app/server/index.mjs`, via `createLogCache` | in-memory |
| ASP `logCache` (`Deposited`, per-pool cursors) | `packages/relayer/.../testnetAsp.service.ts` | in-memory |
| relay `requests` | relayer SQLite (`./data/relayer.sqlite`) | **on disk** |

- **The log caches are in-memory only** — lost on restart (each restart pays one cold sweep),
  per-process, and unbounded. That is currently a *feature*: a cache cannot go stale across a pool
  redeploy, which matters because destination pools have been repointed repeatedly. If these are
  ever persisted, the key **must** include chainId + pool address + event, or a repoint poisons it.
- **Cursors trail the head by `REORG_BUFFER` (16 blocks)**; the trailing window is re-scanned each
  refresh and deduped, so a reorg is re-read rather than missed forever. Dedupe keys must be truly
  unique: leaves use `_index`, ASP deposits use `transactionHash:logIndex`, deposits use
  `precommitment`.
- **Not cached:** `/api/l2/:chain/index` (the Scan path) re-fetches L1 deliveries + L2
  received/activated on every scan via `DataService`. Biggest remaining Infura consumer.
- The ASP poller runs detached on a 10s interval; its refresh is `.catch()`-guarded, because an
  unhandled rejection there takes the **whole relayer process** down over one transient RPC blip.

## 9. Circuit artifacts & verifier consistency

### The rule

A Groth16 verifier is generated **from one specific zkey**. `yarn setup:<circuit>` is randomized —
every run produces a new `delta`, which **silently invalidates every verifier generated from the
previous key**. The circuit can be byte-identical and the proof still gets rejected.

**`alpha` is useless as a check**: it comes from the shared ptau, so it matches across every circuit
and every setup. **`delta` is the discriminator** (phase-2, circuit- and setup-specific).

Ground truth is `build/<circuit>/groth16_pkey.zkey` — that is what `scripts/gen-verifier.sh` reads.
Anything derived from it (the Solidity verifier, the Cairo constants, the served `.zkey` artifact)
must be regenerated together or the set is dead.

### What went wrong here (2026-07-12 → 07-16)

| Artifact | Generated | Result |
| --- | --- | --- |
| `L2WithdrawalVerifier.sol` | 07-12 **01:11** | from the OLD key |
| `build/withdrawL2/groth16_pkey.zkey` | 07-12 **12:54** | re-setup ~12h later → new `delta` |
| Cairo `groth16_verifier_constants.cairo` | 07-13 01:06 | regenerated from the NEW key ✅ |
| OP + Base pools deployed | 07-16 | `new L2WithdrawalVerifier()` baked in the **stale** verifier ❌ |

`DeployL2` constructs a fresh verifier and injects it into the pool, so the stale `.sol` was frozen
into both L2 pools. Starknet and L1 were consistent; **OP and Base would have proven locally and
reverted `InvalidProof` on-chain**. Exactly the failure `FIXES.md` warns about.

Fixed by regenerating from the authoritative zkey (Solidity, Cairo and zkey now all agree):

```bash
cd packages/circuits && sh ./scripts/gen-verifier.sh withdrawL2 L2WithdrawalVerifier
```

⚠️ **The verifier is constructor-injected, so it cannot be swapped in place** — the OP and Base
pools had to be **redeployed** (§3a/§3b) and their bridge configs re-pointed. Starknet was unaffected.

**Resolved 2026-07-17:** verifier regenerated; OP → pool `0x8EDa42e5…` / verifier `0xd2709aD0…`;
Base → pool `0x37ac59BE…` / verifier `0x643aA915…`; both bridge configs re-pointed; `app/.env`
updated. Verified on-chain: each pool's `L1_POOL` is the canonical L1 and each Entrypoint bridge
points at the new pool.

### Checking it yourself (do this before trusting any withdrawal)

```bash
python3 - <<'PY'
import json, re
vk  = json.load(open("packages/circuits/build/withdrawL2/groth16_vkey.json"))
sol = open("packages/contracts/src/contracts/verifiers/L2WithdrawalVerifier.sol").read()
c = lambda n: (re.search(rf"uint256 constant {n}\s*=\s*(\d+);", sol) or [None,None])[1]
print("match:", all(c(k)==v for k,v in {
  "deltax1": vk["vk_delta_2"][0][1], "deltax2": vk["vk_delta_2"][0][0],
  "deltay1": vk["vk_delta_2"][1][1], "deltay2": vk["vk_delta_2"][1][0]}.items()))
PY
```

### Serving the artifacts to the browser

The app serves `/api/circuits/artifacts` from
`node_modules/@0xbow/privacy-pools-core-sdk/dist/node/artifacts/` → i.e. **`packages/sdk/dist/node/artifacts/`**
(the SDK is a symlink to `packages/sdk`). The SDK's `downloadArtifacts` fetches **all three circuits
eagerly** via `Promise.all`, so **all 9 files must exist** or nothing proves — even though the Vault
only ever uses withdrawL1/withdrawL2. Symptom: `Cannot GET /api/circuits/artifacts/commitment.wasm`.

| Artifact | Source | Verified against |
| --- | --- | --- |
| `withdrawL1.{wasm,zkey,vkey}` | `build/withdrawL1/{withdrawL1_js/withdrawL1.wasm, groth16_pkey.zkey, groth16_vkey.json}` | deployed `WithdrawalVerifier` ✅ (nPublic=10) |
| `withdrawL2.{wasm,zkey,vkey}` | `build/withdrawL2/…` | regenerated `L2WithdrawalVerifier` + Cairo ✅ (nPublic=5) |
| `commitment.{zkey,vkey}` | `trusted-setup/final-keys/commitment.{zkey,vkey}` | deployed `CommitmentVerifier` ✅ (nPublic=4) |
| `commitment.wasm` | ⚠️ **no matching source** — `build/commitmentL1` is a *different* circuit (2 public inputs, not 4); staged anyway so the SDK can init | ragequit proving is therefore broken; deposit/send/withdraw unaffected |

Staging is automated — **run `yarn present` in `packages/circuits`** after any setup/rebuild. The
script writes the 9 files into `packages/sdk/dist/node/artifacts/` (previously it copied
non-existent `commitment`/`withdraw` circuits into an unused dir and was silently useless).

## 10. Verification commands (what "working" looks like)

```bash
# L1 config read live from the deployed Entrypoint (min deposit, vetting fee):
curl -s localhost:8787/api/config | jq

# Pool scope matches on-chain (recovery + proofs derive correctly):
cast call 0x98657a6690bd0b4b4b224d5c44d100a6fb9eb3a2 "SCOPE()(uint256)" --rpc-url $ETHEREUM_SEPOLIA_RPC

# Relayer up + fee config:
curl -s "localhost:8788/relayer/details?chainId=11155111&assetAddress=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" | jq

# App → relayer ASP proxy reachable (404 for an unknown label is correct):
curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/api/asp/proof/1

# A destination pool's immutable L1 binding (MUST equal the canonical L1):
cast call <L2_POOL> "L1_POOL()(address)" --rpc-url $OP_SEPOLIA_RPC
```

Confirmed on 2026-07-16: deposit config + indexing ✅, scope match ✅, relayer +
ASP up and proxied ✅. OP `L1_POOL()` = `0x8D508e…` (≠ canonical) — the open item.

---

## 11. Order of operations (clean slate)

1. Deploy L1 protocol → `yarn deploy:protocol:sepolia --broadcast` (done: Set A).
2. For each destination: deploy the L2/Cairo pool **bound to the canonical L1**,
   then configure its bridge on the Entrypoint (§3).
3. `updateroot` / testnet ASP: ensure labels are approved (relayer testnet ASP
   mode approves all deposit labels automatically).
4. Fill `app/.env` (§6) — including the ⚠️ L2/Starknet relayer keys.
5. Start the relayer (`CONFIG_PATH=./config.sepolia.json`) and the app.
6. Run the §7 checks. Then a real browser deposit → send → scan → withdraw.

---

## 12. Open items

**Done** (2026-07-17): OP pool rebind + bridge re-point · Base deploy + bridge config + app wiring ·
Starknet Cairo pool rebind + `configure:bridge:starknet-sepolia` + keys · ASP root published ·
relayer `.env` + key moved out of the tracked JSON · log chunking + caching + retry.

Remaining:

- **Split the relayer signer from the owner.** Everything currently runs as the deployer
  `0x0eB4d30c…` (owner + postman + relayer + all L2 signers). Fine on testnet, wrong for mainnet:
  a leaked relayer key would imply protocol ownership. Rotate to a dedicated key with only
  `ASP_POSTMAN`, then fund it (in that order).
- **`config.sepolia.json` is still tracked and its history contains the old key** `0x660cA938…`
  (now unused and unfunded, so inert). If this repo ever goes public or holds mainnet value:
  `git rm --cached` it, gitignore it (`config.sepolia.example.json` stays as the template), and
  treat any key ever committed as burned.
- **Cache the Scan path.** `/api/l2/:chain/index` still re-fetches L1 deliveries + L2
  received/activated on every scan via `DataService` — the biggest remaining Infura consumer.
- **Starknet fees** — `STARKNET_SEPOLIA_MESSAGE_FEE_WEI` / `_TOKEN_FEE_WEI` are placeholders
  (`1e14`); tune against real StarkGate costs before relying on them.
- **Persisting the log caches** is *not* obviously desirable — see §8; an in-memory cache cannot go
  stale across a pool repoint, which has happened repeatedly here.

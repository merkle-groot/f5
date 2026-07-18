# Cutout — Deployment Guide

The canonical, happy-path guide to deploying the protocol and wiring every component to it.
Verified against the live Sepolia testnet on 2026-07-17.

> **Source of truth.** The deploy scripts emit machine-readable records to
> `packages/contracts/deployments/<chainId>.json` and
> `packages/starknet-pool/deployments/starknet-<chainId>.json`. Those records — not this
> document, and not anyone's memory — are authoritative. Everything else (the three `.env`
> files, the relayer JSON) is a *copy* of them, and copies drift.
>
> **`ops/check-deployment.sh` exists to catch that drift.** Run it after every stage below and
> before trusting any environment. See [§7](#7-verify-the-deployment).

---

## 1. The one invariant that matters

Every withdrawal is Mode 3: spend an L1 note, canonically bridge its value to a destination
shielded pool, deliver a stealth commitment there. A destination pool **immutably binds one L1
pool** (`L1_POOL` on the EVM pool, `l1_pool` on the Cairo pool) and rejects any note that did not
originate there.

**Therefore every destination must bind the same canonical L1 pool.** Bind the wrong one and the
failure is silent and expensive: the ETH bridges across fine, but the note is rejected on arrival —
value lands in a pool that will never release it. This binding is set once at construction and can
never be changed.

This is the first thing `check-deployment.sh` verifies, offline from the records and again on-chain
by reading `L1_POOL()`. Do not skip it.

---

## 2. Prerequisites

| Tool | Used for | Notes |
| --- | --- | --- |
| `foundry` (`forge`, `cast`) | L1 + EVM-L2 deploys, on-chain checks | `foundryup` |
| `jq` | reading deploy records | `brew install jq` |
| `sncast` (Starknet Foundry) | Cairo pool deploy | pins JSON-RPC spec 0.10.x — see [§5.4](#54-starknet-sepolia) |
| `yarn` + Node | app, relayer, circuits | repo uses Yarn workspaces |
| `python3` | Starknet deploy script internals | already required by `deploy-starknet.sh` |

A funded deployer account. On testnet the deployer doubles as protocol owner and postman; on
mainnet, **split these** (see [§6.3](#63-signers-and-roles)).

---

## 3. Component map

| Component | Role | Address config lives in | Deployed? |
| --- | --- | --- | --- |
| `packages/contracts` | L1 pool + Entrypoint + EVM-L2 pools (Foundry) | `.env` (deploy inputs) + `deployments/*.json` (outputs) | you deploy it |
| `packages/starknet-pool` | Cairo destination pool (sncast) | `.env` + `deployments/starknet-*.json` | you deploy it |
| `packages/relayer` | L1 relay + testnet ASP root publisher | `.env` (secrets/knobs) + `config.sepolia.json` (structured) | you run it |
| `app` | Vault UI + API boundary; submits the L2 legs | `.env` | you run it |
| `packages/sdk` | proof/note library | **no address config** — callers pass addresses in | — |

> **The SDK takes no deployment env.** It is a library; the app and relayer construct it and hand
> it addresses at call time. Its only env var is `HYPERSYNC_API_KEY`, read in tests. There is
> nothing to "set" for a deployment — `check-deployment.sh` reports this explicitly rather than
> leaving you wondering.

---

## 4. Deploy the L1 protocol

From `packages/contracts`. Fill `.env` from `.env.testnet.example` first: `DEPLOYER_ADDRESS`,
`OWNER_ADDRESS`, `POSTMAN_ADDRESS`, `ETHEREUM_SEPOLIA_RPC`, and `DEPLOYMENT_VERSION`.

```bash
cd packages/contracts
yarn deploy:protocol:sepolia --broadcast
```

This deploys the withdrawal + ragequit verifiers, the Entrypoint (proxy + impl), and the native-ETH
PrivacyPool, then writes `deployments/11155111.json`. Read the canonical L1 pool + entrypoint back
out of that file — you will paste them everywhere else.

Two things to know:

- **`DEPLOYMENT_VERSION` bumps the CreateX salt.** Addresses are deterministic per
  `(deployer, salt, version)`. v0 and v1 salts are already consumed on Sepolia; reusing one fails
  with CreateX `FailedContractCreation`. To redeploy cleanly, increment `DEPLOYMENT_VERSION`
  (current canonical set is **v2**).
- **The `:sepolia` alias does not Etherscan-verify.** To verify source after the fact:
  `yarn verify:protocol:sepolia`.

Then confirm the L1 records landed on-chain:

```bash
cd ../.. && ./ops/check-deployment.sh --onchain
```

---

## 5. Deploy the destinations

Each destination is deployed, then its Entrypoint bridge config is pointed at it. The per-chain
`yarn` aliases set `L2_TARGET` and pick the matching RPC themselves — you do **not** edit
`L2_TARGET` in `.env`. Fill the relevant prefixed block in `packages/contracts/.env`, set
`L1_POOL_ADDRESS` + `ENTRYPOINT_ADDRESS` to the canonical L1 from §4, and go.

### 5.1 OP Sepolia

```bash
cd packages/contracts
yarn deploy:l2:op-sepolia --broadcast                # deploys pool bound to L1_POOL_ADDRESS
# copy the emitted pool address into OP_SEPOLIA_L2_POOL_ADDRESS, then:
yarn configure:bridge:op-sepolia --broadcast         # points the Entrypoint at that pool
```

### 5.2 Base Sepolia

Identical scripts, `BASE_SEPOLIA_*` prefix. Verify the Base L1 messenger/bridge addresses
([§8](#8-reusable-network-infrastructure)) before broadcasting.

```bash
yarn deploy:l2:base-sepolia --broadcast
# copy into BASE_SEPOLIA_L2_POOL_ADDRESS, then:
yarn configure:bridge:base-sepolia --broadcast
```

### 5.3 Arbitrum Sepolia

Arbitrum is EVM but **not** OP-Stack: it delivers L1→L2 messages as retryable tickets (no messenger)
and prepays L2 execution up front. So it uses its own pool and its own config script, and the
`ARB_SEPOLIA_*` block carries the retryable gas/fee terms (Inbox, L1 Gateway Router,
`MESSAGE_GAS_LIMIT`, `MESSAGE_MAX_FEE_PER_GAS`, `MESSAGE_SUBMISSION_COST`; ERC20 destinations add the
matching `TOKEN_*` terms and `L2_TOKEN_ADDRESS`). Pad the fee terms — Arbitrum's are dynamic, and an
under-provisioned ticket fails to auto-redeem (the pool refunds any unused prepaid `msg.value`).

```bash
cd packages/contracts
# fund the deployer with Arbitrum Sepolia ETH first (deploy costs ~0.00011 ETH)
yarn deploy:l2:arb-sepolia --broadcast               # deploys L2PrivacyPoolArbitrum (alias auth, no messenger)
# copy the emitted pool address into ARB_SEPOLIA_L2_POOL_ADDRESS, then:
yarn configure:bridge:arb-sepolia --broadcast        # sets BridgeConfig{kind: Arbitrum} on the Entrypoint
```

See [`ARBITRUM_SUPPORT.md`](./ARBITRUM_SUPPORT.md) for the full Arbitrum architecture, fee model, and
verified canonical endpoints.

### 5.4 Starknet Sepolia

The Cairo pool is deployed with `sncast`, not Foundry. Its inputs live in
`packages/starknet-pool/.env` (`SN_ACCOUNT`, `SN_RPC`, `L1_POOL_ADDRESS`, `SN_ASSET_ADDRESS`).

```bash
cd packages/starknet-pool
./deploy/deploy-starknet.sh                           # declares+deploys verifier & pool; prints addresses
#   writes deployments/starknet-<chainId>.json, bound to L1_POOL_ADDRESS
cd ../contracts
# put the printed pool felt in STARKNET_SEPOLIA_L2_POOL_FELT, then:
yarn configure:bridge:starknet-sepolia --broadcast    # without this, the pool path reverts UnsupportedChain
```

> **The Cairo deploy and the app need DIFFERENT Starknet RPC nodes.** They pin incompatible
> JSON-RPC spec versions and each hard-fails on the other's endpoint. `sncast` (deploy, `SN_RPC`)
> needs spec **0.10.x**; `starknet.js` 6.x (app, `STARKNET_RPC_URL`) needs **0.8.x**. A
> `starknet_chainId` curl succeeds on both and will *not* catch the mismatch — verify with the
> actual tool. Do not try to unify them.

After each destination:

```bash
cd ../.. && ./ops/check-deployment.sh --onchain
```

This confirms the pool has code, its `L1_POOL()` equals the canonical L1, and the Entrypoint's
`getBridgeConfig` actually routes the chain to that pool (`isSupported == true`).

---

## 6. Wire the components

Addresses come straight from the deploy records. `check-deployment.sh` compares every one of these
against the records, so treat a clean run as the definition of "wired correctly."

### 6.1 `app/.env`

Start from `app/.env.sepolia.example`. Set from the L1 record: `POOL_ADDRESS`, `ENTRYPOINT_ADDRESS`,
`POOL_SCOPE`, `DEPLOYMENT_BLOCK`, `CHAIN_ID`, plus `PUBLIC_RPC_URL`. Then per destination:

| Var | Source |
| --- | --- |
| `L2_EVM_CHAINS` | comma list of EVM keys to advertise, e.g. `op,base` |
| `L2_AUTO_ACTIVATE` / `L2_AUTO_ACTIVATE_POLL_MS` | `true` / polling interval (default `10000` ms); activates backed notes from public events without recipient involvement |
| `OP_POOL_ADDRESS` / `OP_DEPLOYMENT_BLOCK` / `OP_CHAIN_ID` / `OP_RPC_URL` | OP record |
| `OP_RELAYER_PRIVATE_KEY` | funded OP account (submits the OP leg) |
| `BASE_*` (same shape) | Base record |
| `STARKNET_POOL_ADDRESS` / `STARKNET_ASSET_ADDRESS` | Cairo record |
| `STARKNET_DEPLOYMENT_BLOCK` | the block the Cairo pool was deployed at — **mandatory** |
| `STARKNET_RPC_URL` / `STARKNET_RELAYER_ADDRESS` / `STARKNET_RELAYER_PRIVATE_KEY` | app-side Starknet node + funded account |

> **Deploying a destination and *exposing* it are two separate steps.** The app only advertises
> keys listed in `L2_EVM_CHAINS`. A destination can be fully deployed, bound, and bridge-configured
> yet still invisible because its key is missing from that list — this is exactly how Base once
> stayed dark. `check-deployment.sh` §5 flags a deployed-but-unadvertised destination.

> **`STARKNET_DEPLOYMENT_BLOCK` is not optional.** `starknet_getEvents` pages by block range and
> returns a continuation token for every window even when empty, so scanning from block 0 costs
> ~148 sequential round-trips per event type. The Cairo record carries no block, so the checker can
> only sanity-check this one (warns if unset/0) rather than cross-check it.

### 6.2 `packages/relayer` — two files, different jobs

`.env` (gitignored) holds process knobs and **secrets**; `config.sepolia.json` (git-tracked) holds
structured, non-secret config.

`packages/relayer/.env` (from `.env.example`):

| Var | Value |
| --- | --- |
| `CONFIG_PATH` | `./config.sepolia.json` (required; else it looks for `./config.json` and exits) |
| `PORT` / `HOST` | `8788` / `0.0.0.0` |
| `TESTNET_ASP_MODE` | `true` — mirrors deposit labels into the Entrypoint ASP root; without it `/relayer/asp/proof/:label` 404s and withdrawals cannot prove association |
| `RELAYER_PRIVATE_KEY` | the L1 signer (see [§6.3](#63-signers-and-roles)); overrides the JSON |

`packages/relayer/config.sepolia.json` — set `chains[].entrypoint_address` to the canonical
entrypoint and `chains[].asp_pools[0]` to `{ pool_address: <canonical L1>, start_block: <L1 block> }`.

> **Keep secrets out of `config.sepolia.json` — it is committed.** Do not put a private key there;
> the schema makes `signer_private_key` optional precisely so the key can live in `.env`. As of
> this writing the file also contains an RPC URL with an embedded provider API key — move that URL
> to `.env` and rotate the key. `check-deployment.sh` §6 warns on both a committed API key and
> anything key-shaped in that file.

### 6.3 Signers and roles

There is **no single relayer key** — a full end-to-end withdrawal touches up to four funded
accounts:

| Signer | Submits | Stored in |
| --- | --- | --- |
| L1 relay | `relay` + publishes the ASP root | `packages/relayer/.env` → `RELAYER_PRIVATE_KEY` |
| OP | `activateNote` + `withdrawL2` on OP | `app/.env` → `OP_RELAYER_PRIVATE_KEY` |
| Base | same, on Base | `app/.env` → `BASE_RELAYER_PRIVATE_KEY` |
| Starknet | `activate_note` + `withdraw` on Starknet | `app/.env` → `STARKNET_RELAYER_PRIVATE_KEY` |

The L2 legs are submitted by the **app server**, not the relayer — the relayer only does the L1
relay, because its config declares only the Sepolia chain.

The L1 signer must hold Sepolia ETH **and** the `ASP_POSTMAN` role (role id `1`). **Either one
missing fails the ASP publish**, and the failure is sneaky: the label tree still builds in memory,
so `/relayer/asp/proof` returns a proof, but `updateRoot` never lands and the withdrawal then
reverts on-chain with `IncorrectASPRoot`. **Symptom: prove succeeds, submit fails.** Check
`Entrypoint.latestRoot()` against the relayer's proof root before debugging anything else.

To grant the role to a new signer (rotate the key *before* funding — never fund a leaked key):

```bash
cd packages/contracts && source .env
cast send <NEW_SIGNER> --value 0.05ether --account DEPLOYER --rpc-url $ETHEREUM_SEPOLIA_RPC
yarn assignrole:sepolia --broadcast     # prompts: account = <NEW_SIGNER>, role = 1
```

On testnet all four roles are the deployer, which is convenient but means the relayer signer is
also the protocol owner. **For mainnet, split them** — a compromised relayer key must not imply
ownership; grant the relayer only `ASP_POSTMAN`.

### 6.4 Gas on the destination

Every recipient lands with a shielded note and zero native L2 gas. To seed the L2 relayer account
that submits the destination legs, bridge ETH to it:

```bash
cd packages/contracts
# .env: BRIDGE_AMOUNT_WEI set, <TARGET>_RELAYER_ADDRESS is the recipient
yarn bridge:funds:op-sepolia
```

---

## 7. Verify the deployment

The drift checker is the acceptance test for a deployment. It treats `deployments/*.json` as truth
and verifies that every consumer — `app/.env`, both relayer files, `packages/contracts/.env`,
`packages/starknet-pool/.env` — agrees, then (with `--onchain`) that the chain agrees too.

```bash
# from the repo root
yarn check:deployment            # offline: records + every .env, fast
yarn check:deployment:onchain    # also: contract code, SCOPE(), L1_POOL(), Entrypoint routing
# or directly:
./ops/check-deployment.sh [--onchain]
```

What it checks, in order:

1. **Records exist** — L1 pool + entrypoint, and each destination pool (or flags "not deployed").
2. **Binding invariant** — every destination's `l1Pool` equals the canonical L1 ([§1](#1-the-one-invariant-that-matters)).
3. **`packages/contracts/.env`** — deploy inputs match the records.
4. **`app/.env`** — pool, entrypoint, scope, block, chain ids, and every `OP_*` / `BASE_*` / `STARKNET_*` address.
5. **Exposure** — every deployed EVM destination appears in `L2_EVM_CHAINS`, and vice-versa.
6. **`packages/relayer`** — `.env` knobs + `config.sepolia.json` entrypoint/pool/block; warns on committed secrets.
7. **`packages/starknet-pool/.env`** — bound L1 + asset felt.
8. **`packages/sdk`** — reported as no-address-surface (see [§3](#3-component-map)).
9. **Stale records** — historical deployments bound to a non-canonical L1, kept as history — never wire these.
10. **On-chain** (`--onchain`) — code is live, `SCOPE()` matches, the Entrypoint routes each chain to the expected pool (`isSupported`), and each L2's `L1_POOL()` matches.

It is strictly read-only: it parses `.env` files rather than sourcing them (never executes them),
never writes, and redacts provider API keys from its output. Exit code `0` = consistent,
`1` = drift or a missing deployment, `2` = a usage or tooling error. That makes it usable as a CI
or pre-release gate.

---

## 8. Reusable network infrastructure

These are network constants, not per-deployment — reuse them across redeploys.

| Chain | L2 messenger (predeploy) | L1 messenger | L1 standard bridge | Chain id |
| --- | --- | --- | --- | --- |
| OP Sepolia | `0x4200…0007` | `0x58Cc85b8D04EA49cC6DBd3CbFFd00B4B8D6cb3ef` | `0xFBb0621E0B23b5478B630BD55a5f21f67730B0F1` | 11155420 |
| Base Sepolia | `0x4200…0007` | `0xC34855F4De64F1840e5686e64278da901e261f20` | `0xfd0Bf71F60660E2f608ed56e1659C450eB113120` | 84532 |

| Starknet Sepolia | Value |
| --- | --- |
| Starknet Core (L1) | `0xE2Bb56ee936fd6433DC0F6e7e3b8365C906AA057` |
| StarkGate ETH bridge (L1) | `0x8453FC6Cd1bCfE8D4dFC069C400B433054d47bDc` |
| Chain id (felt, `SN_SEPOLIA`) | `393402133025997798000961` |
| `receive_note` selector | `0xafb78720fe8e7dad4e1079e5a4a9ca568567c1eaad64c3c662ef968d138664` (recompute only if the handler is renamed: `starkli selector receive_note`) |

Re-verify Base's L1 addresses against the current Base Sepolia deployment before any mainnet-money use.

---

## 9. Run the services

| Service | Command (from repo root) | Port | Serves |
| --- | --- | --- | --- |
| Circuit artifacts | `cd packages/circuits && yarn present` | — | stages the `.zkey` + verifier artifacts the app/relayer serve |
| Relayer + testnet ASP | `cd packages/relayer && CONFIG_PATH=./config.sepolia.json yarn start:ts` | 8788 | `/relayer/quote`, `/relayer/request`, `/relayer/asp/proof/:label` |
| App API + client | `cd app && yarn dev` | 8787 (+ Vite 5173) | `/api/*`, the Vault UI |

The app proxies `/api/relayer/*` → `RELAYER_API_URL`, and (when `ASP_API_URL` is empty)
`/api/asp/proof/:label` → the relayer's ASP endpoint. **One running relayer covers both the relayer
and ASP flags.**

Confirm health: `GET /api/config` should advertise the destinations in `L2_EVM_CHAINS`, and
`Entrypoint.latestRoot()` should equal the relayer's ASP tree root.

---

## 10. Gotchas that have actually bitten this deployment

- **Verifier is constructor-injected, so it cannot be swapped in place.** A Groth16 verifier is
  generated from one specific zkey; re-running the randomized setup produces a new `delta` that
  silently invalidates every verifier built from the old key (the circuit can be byte-identical and
  proofs still get rejected). `delta`, not `alpha`, is the discriminator. If the zkey changed, the
  Solidity verifier, Cairo constants, and served `.zkey` must be regenerated together — and because
  `DeployL2` bakes the verifier into the pool at construction, **the pool must be redeployed**, not
  patched. Regenerate: `cd packages/circuits && sh ./scripts/gen-verifier.sh withdrawL2 L2WithdrawalVerifier`.
- **Redeploy needs a fresh `DEPLOYMENT_VERSION`** — consumed salts fail with CreateX
  `FailedContractCreation` ([§4](#4-deploy-the-l1-protocol)).
- **Infura caps `eth_getLogs` at 10k blocks.** A deploy-block→latest sweep is a time bomb: fine for
  the first ~10k blocks, then fails forever. Historical reads are chunked into `LOG_CHUNK_BLOCKS`
  (default 9000) windows, serially. Lower it for stricter providers.
- **Deployment blocks are load-bearing for indexing**, not cosmetic — see the Starknet note in
  [§6.1](#61-appenv).

For deeper post-mortems (indexing/caching internals, the full verifier-consistency incident, signer
resolution order), see `DEPLOYMENT_RUNBOOK.md`. **When that document and this one disagree on an
address, both are wrong until you re-run `check-deployment.sh` — the record wins.**

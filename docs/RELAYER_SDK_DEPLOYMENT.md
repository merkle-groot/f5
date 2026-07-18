# F5 Relay, SDK, and Deployment Guide

This document describes the current F5 testnet system: the browser application,
app backend, SDK, TypeScript relayer, Foundry deployment scripts, operating
scripts, and current blockers.

Reference deployment:

- Ethereum Sepolia L1: chain ID 11155111
- OP Sepolia L2: chain ID 11155420
- Native ETH pools
- Independent gas-paying relayer
- Testnet ASP mode that rebuilds the ASP tree from deposit events

## 1. Architecture

### Contracts

The contracts package has four main layers.

1. Entrypoint:
   - registers pools and asset configuration;
   - stores minimum deposits, vetting fees, and maximum relay fees;
   - stores ASP association roots;
   - stores destination bridge configuration;
   - controls owner and ASP postman roles.

2. L1 PrivacyPool:
   - accepts deposits;
   - inserts commitments into a Poseidon incremental Merkle tree;
   - verifies L1 withdrawal proofs;
   - spends notes and dispatches destination note/value delivery.

3. L2PrivacyPool:
   - receives authenticated cross-domain note messages;
   - holds bridged ETH/token backing;
   - records notes as pending until backing arrives;
   - activates backed notes into the L2 state tree;
   - verifies and executes final L2 withdrawals.

4. Groth16 verifiers:
   - commitment verifier;
   - L1 withdrawal verifier;
   - L2 withdrawal verifier.

The Solidity proof libraries and circuits must agree exactly on public-signal
ordering. A signal-index mismatch invalidates otherwise valid proofs.

### SDK

The SDK lives in packages/sdk. It provides:

- Poseidon precommitment and commitment hashing;
- deposit and withdrawal secret derivation;
- Baby Jubjub stealth-note construction;
- L1 and L2 Merkle-tree reconstruction;
- state and ASP inclusion proofs;
- Groth16 proof generation and local verification;
- contract-call formatting;
- deposit, delivery, activation, and withdrawal event indexing.

The SDK does not own the browser vault, wallet connection, relayer policy, or
server key management.

### Browser app

The app lives in app/.

The browser frontend:

- connects to the user's wallet;
- generates deposit secrets;
- encrypts notes locally;
- creates destination stealth notes;
- fetches state/ASP proofs;
- generates L1 and L2 proofs locally;
- sends quotes and proof payloads to the backend.

The app backend in app/server/index.mjs:

- serves /api/config;
- reads live pool configuration from Entrypoint.assetConfig;
- indexes L1 and L2 events;
- reconstructs state trees and returns proofs;
- proxies quote, relay, and ASP requests;
- submits L2 activation and L2 withdrawal transactions.

The backend should not receive the user's original note secret or nullifier in
the ordinary relay flow.

### Relayer

The relayer lives in packages/relayer.

Routes:

~~~text
GET  /ping
GET  /relayer/details
POST /relayer/quote
POST /relayer/request
GET  /relayer/asp/proof/:label
~~~

It validates requests, calculates fees and gas, signs fee commitments, validates
proof payloads, submits L1 relay transactions, optionally publishes testnet ASP
roots, and pays transaction gas from its configured account.

## 2. Deposit flow

### Browser-side secrets

The browser generates two random field elements:

~~~text
nullifier
secret
~~~

It computes:

~~~text
precommitment = Poseidon(nullifier, secret)
~~~

Only the precommitment is sent to PrivacyPool.deposit. The nullifier and secret
are not included in the deposit transaction.

### L1 commitment

The L1 pool creates a fresh label:

~~~text
label = keccak256(abi.encodePacked(scope, nonce)) mod SNARK_SCALAR_FIELD
~~~

After deducting the vetting fee, it computes:

~~~text
commitment = Poseidon(netDepositValue, label, precommitment)
~~~

The commitment is inserted into the L1 state tree. Deposited contains the
commitment, label, net value, and precommitment, but not the nullifier or secret.

### Local note encryption

After event reconciliation, the browser creates a note containing value, label,
nullifier, secret, precommitment, commitment, and transaction hash.

Before writing to localStorage under an f5-note-* key:

1. The wallet signs the fixed F5 note-vault message.
2. Signature bytes are hashed with SHA-256.
3. The digest becomes an AES-GCM key.
4. A fresh 12-byte IV is generated.
5. The note JSON is encrypted.
6. Ciphertext, IV, version, algorithm, and wallet address are stored.

The frontend includes a compatibility fallback for notes created with the old
vault message. This is browser-local encryption, not a hardware vault. Same-origin
XSS could still access the encrypted payload and request wallet signatures.

## 3. Two-step Mode-3 withdrawal

The EVM flow is:

~~~text
L1 note spend + bridge dispatch
          |
          v
L2 note delivery + activation
          |
          v
L2 note spend to final recipient
~~~

### Destination note

A recipient shielded address contains:

~~~text
B = b * G       spend public key
V = v * G       view public key
~~~

The sender creates ephemeral scalar e:

~~~text
E  = e * G
ss = e * V
P  = B + Poseidon(ss) * G
r  = Poseidon(ss, 1)
Cdest = Poseidon(P.x, P.y, value, r)
~~~

The L1 proof commits to E, a view tag, Cdest, destination chain data, and the
bridged amount. The recipient recomputes ss as v * E and derives the one-time
spend key.

### Quote and L1 proof

The frontend calls /api/relayer/quote, which proxies to /relayer/quote.
A quote returns the fee, gas estimate, and—when a recipient is supplied—a signed
fee commitment.

The signed commitment contains the exact withdrawal data bound by the proof
context. The browser must use those exact bytes for proof generation and relay
submission.

The browser obtains:

- the L1 state proof for the selected commitment;
- current L1 state root;
- ASP proof for the selected label;
- current ASP root;
- fee commitment;
- destination note data.

The SDK generates and locally verifies withdrawL1.

### L1 relay

The browser sends /api/relayer/request, which proxies to /relayer/request.

The relayer validates:

- request schema;
- supported source chain;
- maximum gas price;
- proof structure;
- ten L1 public signals;
- fee commitment;
- proof validity and context.

It calls the L1 pool from its own account. The pool spends the original note,
creates any L1 change note, and dispatches the destination note/value through
the configured bridge.

### L2 delivery, activation, and final spend

Bridge delivery has two separate effects:

1. the cross-domain message creates a pending L2 note;
2. bridged ETH arrives as L2 backing.

The app backend polls public `NoteReceived` / `NoteActivated` events. When a
pending note has bridge backing, it submits `activateNote` with the destination
transaction key; no recipient request or private note material is required.
`/api/l2/activate` remains available as an operational fallback.

After activation, the app reconstructs the L2 tree and the SDK generates
withdrawL2 locally. The app sends /api/l2/withdraw and the backend submits the
final withdrawal to the L2 pool.

## 4. Testnet ASP mode

Implementation: packages/relayer/src/services/testnetAsp.service.ts.

Enable it with:

~~~bash
TESTNET_ASP_MODE=true
TESTNET_ASP_POLL_MS=10000
~~~

For each configured chain it:

1. reads Deposited events from every asp_pools entry;
2. orders logs by block and log index;
3. extracts every label;
4. rebuilds a Poseidon LeanIMT;
5. keeps the tree in memory;
6. reads Entrypoint.latestRoot();
7. calls Entrypoint.updateRoot when the root differs.

Proof endpoint:

~~~text
GET /relayer/asp/proof/:label?chainId=11155111
~~~

A new Entrypoint has no root, so latestRoot initially reverts. The watcher
treats that as an empty root and publishes the first root. It checks signer
balance and ASP_POSTMAN before publishing and reports failures without taking
down the HTTP server.

This is only a permissive testnet ASP. It has no durable database, operator
approval workflow, root archive, association policy, or production monitoring.

## 5. Foundry deployment and operations

All scripts are in packages/contracts/script. Yarn commands source
packages/contracts/.env.

### L1 deployment

Script: Deploy.s.sol:EthereumSepolia

~~~bash
yarn workspace @privacy-pool-core/contracts deploy:protocol:sepolia --broadcast
~~~

It deploys/reuses verifier libraries, deploys the verifiers, Entrypoint
implementation/proxy, and ETH PrivacyPool, then registers the pool configuration.

Current Sepolia addresses:

~~~text
Entrypoint:       0x157b0c29d676bbBfD3D8a3fB8c4979A5B5EaA793
ETH pool:         0x8D508e422eD2Bc102Ba364875d2D83c172DC2288
Deployment block: 11257510
~~~

Verification is separate:

~~~bash
yarn workspace @privacy-pool-core/contracts verify:protocol:sepolia --broadcast
~~~

An Etherscan key is needed for source verification, not deployment.

### L2 deployment

Script: DeployL2.s.sol:DeployL2Testnet

~~~bash
yarn workspace @privacy-pool-core/contracts deploy:l2:op-sepolia --broadcast
~~~

It uses target-specific values such as:

~~~text
L2_TARGET=OP_SEPOLIA
OP_SEPOLIA_L2_MESSENGER_ADDRESS
OP_SEPOLIA_L2_ASSET_ADDRESS       optional; native ETH by default
OP_SEPOLIA_MAX_RELAY_FEE_BPS      optional
~~~

It writes deployments/11155420.json on broadcast.

Current OP Sepolia addresses:

~~~text
L2 verifier: 0xeEEd6485A583D197F2F5805AdE7Ec6ECBcDA833D
L2 pool:     0xFbBa1F089Fc8E48559B52eb09fF1b07b943ab507
~~~

### L1 bridge configuration

Script: ConfigureOpStackBridge.s.sol:ConfigureOpStackBridge

~~~bash
yarn workspace @privacy-pool-core/contracts configure:bridge:op-sepolia --broadcast
~~~

It writes the native ETH OP Stack configuration to Entrypoint using the
canonical messenger, L1 Standard Bridge, destination chain ID, L2 pool, and
gas limits. The sender must be the Entrypoint owner.

Verify it with:

~~~text
Entrypoint.getBridgeConfig(11155420, nativeAsset)
~~~

### L1 updates

Script: UpdateL1.s.sol.

Manual ASP root update:

~~~bash
ASP_ROOT=<non-zero-poseidon-root> \
ASP_IPFS_CID=testnet-asp-root-all-labels-placeholder \
yarn workspace @privacy-pool-core/contracts update:l1:root:sepolia --broadcast
~~~

The sender must have ASP_POSTMAN.

Pool configuration update:

~~~bash
L1_MINIMUM_DEPOSIT_WEI=1000000000000000 \
L1_VETTING_FEE_BPS=100 \
L1_MAX_RELAY_FEE_BPS=100 \
yarn workspace @privacy-pool-core/contracts update:l1:pool:sepolia --broadcast
~~~

The sender must be an Entrypoint owner. Native ETH is the default asset unless
L1_ASSET_ADDRESS is provided.

### Funding an L2 relayer

Script: BridgeFunds.s.sol:BridgeFundsToOpStack.

~~~bash
OP_SEPOLIA_RELAYER_ADDRESS=<l2-relayer-eoa> \
OP_SEPOLIA_BRIDGE_GAS_LIMIT=200000 \
BRIDGE_AMOUNT_WEI=10000000000000000 \
yarn workspace @privacy-pool-core/contracts bridge:funds:op-sepolia --broadcast
~~~

10000000000000000 wei is 0.01 ETH. The recipient is the L2 relayer EOA, not
the L2 pool. The sender needs L1 ETH for the bridge amount and L1 gas. This
script handles native ETH only.

## 6. Configuration and startup

Relayer config: packages/relayer/config.sepolia.json.

Important fields:

~~~json
{
  "chains": [{
    "chain_id": 11155111,
    "entrypoint_address": "...",
    "asp_pools": [{
      "pool_address": "...",
      "start_block": 11257510
    }],
    "rpc_url": "..."
  }]
}
~~~

Supply the signer outside committed JSON:

~~~bash
export RELAYER_PRIVATE_KEY=<funded-testnet-relayer-key>
~~~

RELAYER_SIGNER_PRIVATE_KEY is also accepted. The signer needs native ETH on
each chain where it sends transactions and ASP_POSTMAN on L1 when ASP mode is
enabled.

Start the relayer:

~~~bash
TESTNET_ASP_MODE=true \
TESTNET_ASP_POLL_MS=10000 \
CONFIG_PATH="$PWD/packages/relayer/config.sepolia.json" \
PORT=8788 \
yarn workspace @privacy-pool-core/relayer build:start
~~~

App config is in app/.env:

~~~text
CHAIN_ID=11155111
PUBLIC_RPC_URL=<Ethereum Sepolia RPC>
POOL_ADDRESS=<L1 pool>
ENTRYPOINT_ADDRESS=<L1 Entrypoint>
DEPLOYMENT_BLOCK=11257510
L2_CHAIN_ID=11155420
L2_RPC_URL=<OP Sepolia RPC>
L2_POOL_ADDRESS=<OP Sepolia pool>
RELAYER_API_URL=http://localhost:8788
~~~

Start the app:

~~~bash
yarn --cwd app dev
~~~

Frontend: http://localhost:5173. App backend: http://localhost:8787.
Relayer: http://localhost:8788.

The app /api/config endpoint reads live Entrypoint.assetConfig. The current
Sepolia deployment should report minimum 0.001 ETH and vetting fee 100 BPS.

## 7. Current blockers

### Relayer signer funding and role

The last ASP startup failed during updateRoot gas estimation:

~~~text
gas required exceeds allowance (0)
~~~

The signer address printed by the relayer had no Sepolia ETH. Fund that exact
address and ensure it has ASP_POSTMAN. The relayer now reports this and stays
alive instead of crashing.

### Bridge configuration confirmation

The bridge configuration script exists, but end-to-end use requires confirming
that it was broadcast successfully and that getBridgeConfig returns the expected
OP Sepolia messenger, Standard Bridge, and L2 pool.

### L2 transaction key and funding

/api/l2/activate and /api/l2/withdraw require an L2 transaction key and native
OP Sepolia ETH. The account must be able to pay activation and final withdrawal
gas.

### Testnet ASP limitations

The watcher is hot-key operated and permissive. It lacks durable state, operator
controls, root archival, policy enforcement, and production monitoring.

### Full Foundry test suite

The default Foundry tree still contains legacy fixtures under
test/unit/core/PrivacyPool.t.sol and related integration/invariant directories.
They target removed APIs and old deposit hooks. The supported production build and
test profile pass, but the default full suite is not a release gate.

### Wallet-enabled E2E

HTTP/API checks and production builds pass, including live /api/config, valid
native ETH quote generation, and HTTP 400 for malformed quote amounts.

A full wallet-enabled test still needs to confirm:

1. real deposit;
2. local note encryption;
3. reload and note unlock;
4. L1 quote and proof;
5. relayer submission;
6. bridge delivery;
7. L2 activation;
8. L2 proof;
9. final L2 withdrawal.

Those steps require a wallet-enabled browser and funded testnet accounts.

### Note migration and key management

Old notes require the original wallet and old signing message. Other wallets,
origins, or unknown formats cannot be decrypted.

Local env files and Foundry keystores are development-grade. Production needs a
secret manager/HSM, separated role keys, rotation, balance monitoring, RPC
rate-limit handling, and restricted API access.

## 8. Verification status

Verified:

- app syntax and production build;
- relayer typecheck and build;
- relayer tests: 15 passed, 1 skipped;
- SDK tests: 137 passed, 5 skipped;
- operational script compilation with legacy tests excluded;
- live app configuration returns the deployed minimum and fee;
- valid native ETH relay quotes work;
- malformed quote amounts return HTTP 400.

Operational scripts:

~~~text
packages/contracts/script/UpdateL1.s.sol
packages/contracts/script/BridgeFunds.s.sol
~~~

Progress tracker: PROGRESS.md

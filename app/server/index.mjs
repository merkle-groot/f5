import "dotenv/config";
import cors from "cors";
import express from "express";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { Account, RpcProvider, hash as snHash } from "starknet";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon } from "maci-crypto/build/ts/hashing.js";
import { Circuits, PrivacyPoolSDK } from "@0xbow/privacy-pools-core-sdk";
import { EventIndex } from "./event-index.mjs";
import { AutomaticNoteActivator, KeyedSerialExecutor, planBackedActivations } from "./note-activator.mjs";
import { retryRpc } from "./rpc-retry.mjs";
import { rpcRuntime } from "./rpc-runtime.mjs";
import { StarknetEventIndex } from "./starknet-event-index.mjs";

const app = express();
const port = Number(process.env.PORT ?? 8787);

function evmClient(chainId, rpcUrl) {
  return rpcRuntime.client(`evm:${chainId}`, rpcUrl);
}

function l1Client(rpcUrl = process.env.PUBLIC_RPC_URL) {
  return evmClient(Number(process.env.CHAIN_ID ?? 1), rpcUrl);
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/api/circuits/artifacts", express.static(fileURLToPath(new URL("../../node_modules/@0xbow/privacy-pools-core-sdk/dist/node/artifacts/", import.meta.url))));

/**
 * Serialize a payload containing bigints.
 *
 * Indexer events are full of them (commitments, labels, nullifiers), and
 * `JSON.stringify` THROWS on a bigint rather than coercing it. Handlers that
 * spread an event straight into `res.json` therefore blew up inside their own
 * try-block and returned a 502 — which is why `/api/activity` never worked.
 */
function sendJson(res, payload, status = 200) {
  return res
    .status(status)
    .type("application/json")
    .send(JSON.stringify(payload, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
}

/**
 * Blocks re-scanned on every refresh. The cursor must trail the chain head:
 * parking it exactly at the head would permanently miss any event that a reorg
 * reshuffles into a block we have already passed.
 */
const REORG_BUFFER = 16n;
const eventIndex = new EventIndex({ runtime: rpcRuntime, reorgBuffer: REORG_BUFFER, retry: withRetry });

const depositedEvent = {
  type: "event",
  name: "Deposited",
  inputs: [
    { name: "_depositor", type: "address", indexed: true },
    { name: "_commitment", type: "uint256", indexed: false },
    { name: "_label", type: "uint256", indexed: false },
    { name: "_value", type: "uint256", indexed: false },
    { name: "_precommitmentHash", type: "uint256", indexed: false },
  ],
};

function parseDepositLog(log) {
  const args = log.args ?? {};
  if (
    args._depositor === undefined ||
    args._commitment === undefined ||
    args._label === undefined ||
    args._value === undefined ||
    args._precommitmentHash === undefined ||
    log.blockNumber === undefined ||
    !log.transactionHash
  ) {
    throw new Error("Invalid Deposited log returned by RPC");
  }
  return {
    depositor: args._depositor.toLowerCase(),
    commitment: args._commitment,
    label: args._label,
    value: args._value,
    precommitment: args._precommitmentHash,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  };
}

async function getDepositEvents({ force = false } = {}) {
  const rpcUrl = process.env.PUBLIC_RPC_URL;
  const poolAddress = process.env.POOL_ADDRESS;
  if (!rpcUrl || !poolAddress) throw new Error("Pool indexing is not configured");

  const chainId = Number(process.env.CHAIN_ID ?? 1);
  const logs = await eventIndex.read({
    chain: `evm:${chainId}`,
    rpcUrl,
    address: poolAddress,
    event: depositedEvent,
    eventKey: "Deposited(address,uint256,uint256,uint256,uint256)",
    fromBlock: BigInt(process.env.DEPLOYMENT_BLOCK ?? "0"),
    force,
  });
  return logs.map(parseDepositLog);
}

let sdk;
function getSdk() {
  if (!sdk) sdk = new PrivacyPoolSDK(new Circuits({ browser: false }));
  return sdk;
}

// Automatic activation and user withdrawals share destination signers. Queue
// writes per signer so independently-created clients cannot reuse one nonce.
const l2TransactionQueue = new KeyedSerialExecutor();

function evmSignerQueueKey(chain) {
  return `evm:${chain.chainId}:${privateKeyToAccount(chain.relayerKey).address.toLowerCase()}`;
}

function starknetSignerQueueKey(config) {
  return `starknet:${config.chainId}:${config.relayerAddress.toLowerCase()}`;
}

const starknetU256 = (value) => {
  const number = BigInt(value);
  const mask = (1n << 128n) - 1n;
  return [number & mask, number >> 128n].map((part) => part.toString());
};

function getStarknetConfig() {
  return {
    rpcUrl: process.env.STARKNET_RPC_URL ?? "",
    chainId: process.env.STARKNET_CHAIN_ID ?? "393402133025997798000961",
    chainName: process.env.STARKNET_CHAIN_NAME ?? "Starknet Sepolia",
    poolAddress: process.env.STARKNET_POOL_ADDRESS ?? "",
    assetAddress: process.env.STARKNET_ASSET_ADDRESS ?? "",
    relayerAddress: process.env.STARKNET_RELAYER_ADDRESS ?? "",
    privateKey: process.env.STARKNET_RELAYER_PRIVATE_KEY ?? "",
  };
}

function getStarknetProvider(config) {
  if (!config.rpcUrl) throw new Error("STARKNET_RPC_URL is not configured");
  let provider = starknetProviders.get(config.rpcUrl);
  if (!provider) {
    provider = new RpcProvider({ nodeUrl: config.rpcUrl });
    starknetProviders.set(config.rpcUrl, provider);
  }
  return provider;
}

const starknetProviders = new Map();
const starknetEventIndex = new StarknetEventIndex({ retry: withRetry, reorgBuffer: Number(REORG_BUFFER) });

/**
 * The configured EVM L2 destinations, one per key in `L2_EVM_CHAINS` (e.g. "op,base").
 *
 * Each destination is a distinct Mode-3 pool on its own chain — OP and Base are NOT one generic
 * "L2". Per-chain vars are read by uppercased prefix (`OP_POOL_ADDRESS`, `BASE_RPC_URL`, ...), so a
 * new chain is added by filling a `<KEY>_*` block and appending the key to `L2_EVM_CHAINS`; no code
 * change. A chain missing its RPC or pool is dropped rather than half-configured.
 */
function getEvmL2s() {
  const keys = (process.env.L2_EVM_CHAINS ?? "op").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return keys
    .map((key) => {
      const P = key.toUpperCase();
      return {
        key,
        chainId: Number(process.env[`${P}_CHAIN_ID`] ?? 0),
        chainName: process.env[`${P}_CHAIN_NAME`] ?? key,
        rpcUrl: process.env[`${P}_RPC_URL`] ?? "",
        poolAddress: process.env[`${P}_POOL_ADDRESS`] ?? "",
        deploymentBlock: process.env[`${P}_DEPLOYMENT_BLOCK`] ?? "0",
        relayerKey: process.env[`${P}_RELAYER_PRIVATE_KEY`] ?? "",
      };
    })
    .filter((c) => c.rpcUrl && c.poolAddress);
}

/** Resolve one EVM L2 by its `:chain` route param, or throw a 404-shaped error. */
function requireEvmL2(key) {
  const chain = getEvmL2s().find((c) => c.key === String(key).toLowerCase());
  if (!chain) {
    const error = new Error(`EVM L2 "${key}" is not configured`);
    error.status = 404;
    throw error;
  }
  return chain;
}

app.get("/api/health", (_req, res) => {
  res.json({
    status: "online",
    network: process.env.CHAIN_NAME ?? "Ethereum mainnet",
    sdk: "ready",
    relayConfigured: Boolean(
      process.env.RELAYER_RPC_URL &&
        process.env.RELAYER_PRIVATE_KEY &&
        process.env.ENTRYPOINT_ADDRESS,
    ),
  });
});

app.get("/api/rpc-metrics", (_req, res) => {
  if (process.env.RPC_METRICS_ENABLED !== "true") {
    return res.status(404).json({ error: "RPC metrics are disabled; set RPC_METRICS_ENABLED=true" });
  }
  res.set("cache-control", "no-store");
  return res.json(rpcRuntime.snapshot());
});

app.get("/api/quote", (_req, res) => {
  const feeBps = BigInt(process.env.RELAY_FEE_BPS ?? "30");
  res.json({
    feeBps: Number(feeBps) / 100,
    feeLabel: `${Number(feeBps) / 100}%`,
    gasCovered: true,
    relayer: process.env.RELAYER_NAME ?? "F5",
  });
});

app.post("/api/relayer/quote", async (req, res) => {
  if (!process.env.RELAYER_API_URL) return res.status(503).json({ error: "RELAYER_API_URL is not configured" });
  try {
    const response = await fetch(`${process.env.RELAYER_API_URL.replace(/\/$/, "")}/relayer/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) });
    return res.status(response.status).json(await response.json());
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "Relayer quote unavailable" });
  }
});

app.post("/api/relayer/request", async (req, res) => {
  if (!process.env.RELAYER_API_URL) return res.status(503).json({ error: "RELAYER_API_URL is not configured" });
  try {
    const response = await fetch(`${process.env.RELAYER_API_URL.replace(/\/$/, "")}/relayer/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) });
    return res.status(response.status).json(await response.json());
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "Relay request unavailable" });
  }
});

app.get("/api/config", async (_req, res) => {
  const config = {
    chainId: Number(process.env.CHAIN_ID ?? 1),
    chainName: process.env.CHAIN_NAME ?? "Ethereum mainnet",
    rpcUrl: process.env.PUBLIC_RPC_URL ?? "",
    poolAddress: process.env.POOL_ADDRESS ?? "",
    scope: process.env.POOL_SCOPE ?? "",
    asset: process.env.ASSET_ADDRESS ?? "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    symbol: process.env.ASSET_SYMBOL ?? "ETH",
    decimals: Number(process.env.ASSET_DECIMALS ?? 18),
    minDepositWei: process.env.MIN_DEPOSIT_WEI ?? "0",
    maxDepositWei: ((1n << 128n) - 1n).toString(),
    vettingFeeBps: Number(process.env.VETTING_FEE_BPS ?? 0),
    // The EVM L2 destinations the client should scan and offer, each with its route key. Starknet
    // is advertised separately via /api/starknet/config.
    l2Chains: getEvmL2s().map((c) => ({ key: c.key, chainId: c.chainId, chainName: c.chainName })),
  };

  const entrypointAddress = process.env.ENTRYPOINT_ADDRESS;
  if (!config.rpcUrl || !entrypointAddress || !config.asset) return res.json(config);

  try {
    const client = l1Client(config.rpcUrl);
    const result = await rpcRuntime.cachedRead(
      `asset-config:${config.chainId}:${entrypointAddress.toLowerCase()}:${config.asset.toLowerCase()}`,
      () => client.readContract({
        address: entrypointAddress,
        abi: [{
          type: "function",
          name: "assetConfig",
          stateMutability: "view",
          inputs: [{ name: "asset", type: "address" }],
          outputs: [
            { name: "pool", type: "address" },
            { name: "minimumDepositAmount", type: "uint256" },
            { name: "vettingFeeBPS", type: "uint256" },
            { name: "maxRelayFeeBPS", type: "uint256" },
          ],
        }],
        functionName: "assetConfig",
        args: [config.asset],
      }),
      { maxAgeMs: Number(process.env.RPC_CONFIG_TTL_MS ?? 30_000) },
    );
    config.minDepositWei = result[1].toString();
    config.vettingFeeBps = Number(result[2]);
    config.maxRelayFeeBps = Number(result[3]);
    return res.json(config);
  } catch (error) {
    console.warn("[CONFIG WARNING] Could not read live asset configuration:", error instanceof Error ? error.message : error);
    return res.json(config);
  }
});

app.get("/api/activity", async (_req, res) => {
  const rpcUrl = process.env.PUBLIC_RPC_URL;
  const poolAddress = process.env.POOL_ADDRESS;
  if (!rpcUrl || !poolAddress) return res.json({ configured: false, deposits: [], withdrawals: [] });

  try {
    const chainId = Number(process.env.CHAIN_ID ?? 1);
    const fromBlock = BigInt(process.env.DEPLOYMENT_BLOCK ?? "0");
    const [deposits, withdrawalLogs] = await Promise.all([
      getDepositEvents(),
      eventIndex.read({
        chain: `evm:${chainId}`,
        rpcUrl,
        address: poolAddress,
        event: withdrawnEvent,
        eventKey: "Withdrawn(uint256,uint256,uint256,uint256)",
        fromBlock,
      }),
    ]);
    const withdrawals = withdrawalLogs.map(parseWithdrawalLog);
    // sendJson, not res.json: these events carry bigints and JSON.stringify throws on them.
    return sendJson(res, { configured: true, deposits: deposits.slice(-12), withdrawals: withdrawals.slice(-12) });
  } catch (error) {
    return sendJson(res, { configured: true, error: error instanceof Error ? error.message : "Unable to read activity", deposits: [], withdrawals: [] }, 502);
  }
});

app.get("/api/deposits/:hash", async (req, res) => {
  try {
    // The caller is polling for a deposit that JUST landed, so the cursor must
    // advance — a plain cached read would never see it.
    const deposits = await getDepositEvents();
    const event = deposits.find((item) => item.transactionHash.toLowerCase() === req.params.hash.toLowerCase());
    if (!event) return sendJson(res, { status: "pending" }, 202);
    return sendJson(res, { status: "confirmed", event });
  } catch (error) {
    return sendJson(res, { error: error instanceof Error ? error.message : "Unable to reconcile deposit" }, 502);
  }
});

/**
 * Every `Deposited` event in the pool.
 *
 * This is what makes the local note vault a CACHE rather than the source of
 * truth: deposit secrets are `Poseidon(master, scope, index)`, so a client
 * holding the mnemonic can walk indices, derive each precommitment, and match it
 * here — recovering every note without any local state. It is public data (the
 * whole pool's deposits), and the matching happens entirely client-side, so
 * asking for it reveals nothing about who is asking.
 */
app.get("/api/l1/deposits", async (req, res) => {
  try {
    // `?refresh=1` forces a full replay — the escape hatch if the cache is ever
    // suspected of having missed a reorg'd range.
    const deposits = await getDepositEvents({ force: req.query.refresh === "1" });
    return sendJson(res, {
      deposits: deposits.map((event) => ({
        commitment: event.commitment,
        label: event.label,
        value: event.value,
        precommitment: event.precommitment,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      })),
    });
  } catch (error) {
    return sendJson(res, { error: error instanceof Error ? error.message : "Unable to index deposits" }, 502);
  }
});

/**
 * Retry a transient RPC failure with backoff. Public nodes answer `-32603 service temporarily
 * unavailable` under load, and one blip should not fail a withdrawal's state proof.
 */
async function withRetry(fn, attempts = 4) {
  return retryRpc(fn, { attempts });
}

const leafInsertedEvent = {
  type: "event",
  name: "LeafInserted",
  inputs: [
    { name: "_index", type: "uint256", indexed: false },
    { name: "_leaf", type: "uint256", indexed: false },
    { name: "_root", type: "uint256", indexed: false },
  ],
};
const withdrawnEvent = {
  type: "event",
  name: "Withdrawn",
  inputs: [
    { name: "_newCommitmentHashL1", type: "uint256", indexed: false },
    { name: "_newCommitmentHashL2", type: "uint256", indexed: false },
    { name: "_value", type: "uint256", indexed: false },
    { name: "_spentNullifier", type: "uint256", indexed: false },
  ],
};

function parseWithdrawalLog(log) {
  const args = log.args ?? {};
  if (
    args._newCommitmentHashL1 === undefined ||
    args._newCommitmentHashL2 === undefined ||
    args._value === undefined ||
    args._spentNullifier === undefined ||
    log.blockNumber === undefined ||
    !log.transactionHash
  ) {
    throw new Error("Invalid Withdrawn log returned by RPC");
  }
  return {
    withdrawn: args._value,
    spentNullifier: args._spentNullifier,
    newCommitment: args._newCommitmentHashL1,
    newCommitmentL2: args._newCommitmentHashL2,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  };
}

function readL1Event(event, eventKey, { force = false } = {}) {
  const rpcUrl = process.env.PUBLIC_RPC_URL;
  const poolAddress = process.env.POOL_ADDRESS;
  const chainId = Number(process.env.CHAIN_ID ?? 1);
  return eventIndex.read({
    chain: `evm:${chainId}`,
    rpcUrl,
    address: poolAddress,
    event,
    eventKey,
    fromBlock: BigInt(process.env.DEPLOYMENT_BLOCK ?? "0"),
    force,
  });
}

app.get("/api/l1/state-proof/:commitment", async (req, res) => {
  const rpcUrl = process.env.PUBLIC_RPC_URL;
  const poolAddress = process.env.POOL_ADDRESS;
  if (!rpcUrl || !poolAddress) return res.status(503).json({ error: "L1 pool indexing is not configured" });
  try {
    const client = l1Client(rpcUrl);
    const logs = await readL1Event(leafInsertedEvent, "LeafInserted(uint256,uint256,uint256)");
    // Sort a copy: `logs` is the cache's own array and must not be reordered in place.
    const ordered = [...logs].sort((a, b) => Number(a.args._index - b.args._index));
    const leaves = ordered.map((log) => log.args._leaf);
    const commitment = BigInt(req.params.commitment);
    // An empty pool has no leaves, and LeanIMT's insertMany rejects an empty array with the
    // singularly unhelpful "There are no leaves to add". Answer the question that was actually
    // asked — the commitment is not in the tree — rather than leaking that internal error. This is
    // the normal state of a freshly deployed pool, and of a vault still holding notes from a
    // previous deployment.
    if (leaves.length === 0) {
      return res.status(404).json({
        error: `The pool at ${poolAddress} has no deposits yet, so no commitment can be proven against it. `
          + "If this note came from an earlier deployment it cannot be spent here. Hit RECOVER to rebuild "
          + "your notes from the current pool.",
      });
    }
    const tree = new LeanIMT((left, right) => poseidon([left, right]));
    tree.insertMany(leaves);
    const index = tree.indexOf(commitment);
    if (index < 0) return res.status(404).json({ error: "Commitment is not in the L1 state tree" });
    const proof = tree.generateProof(index);
    const currentRoot = await client.readContract({ address: poolAddress, abi: [{ type: "function", name: "currentRoot", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "currentRoot" });
    if (tree.root !== currentRoot) return res.status(409).json({ error: "Indexed L1 state root is stale", indexedRoot: tree.root.toString(), onchainRoot: currentRoot.toString() });
    return res.json({ root: proof.root.toString(), depth: tree.depth, proof: { index: proof.index, siblings: proof.siblings.map((item) => item.toString()), root: proof.root.toString() } });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "Unable to reconstruct L1 state tree" });
  }
});

/**
 * The set of nullifier hashes the L1 pool has already burned.
 *
 * A note's local `status` is a write-only cache — it only flips to "spent" after a
 * successful relay in the session that spent it. A note spent on another device, or
 * before a vault recovery (which rebuilds from public deposits and cannot tell a
 * spent note from a live one), stays "ready" and gets offered for a spend the pool
 * then rejects with `NullifierAlreadySpent`. This endpoint is the on-chain source of
 * truth the client reconciles against. `_spentNullifier` IS the nullifier hash the
 * pool marks spent — the same value the withdrawal circuit exposes as
 * `existingNullifierHash` — so no hashing is needed here.
 */
app.get("/api/l1/spent-nullifiers", async (req, res) => {
  const rpcUrl = process.env.PUBLIC_RPC_URL;
  const poolAddress = process.env.POOL_ADDRESS;
  if (!rpcUrl || !poolAddress) return res.status(503).json({ error: "L1 pool indexing is not configured" });
  try {
    const logs = await readL1Event(
      withdrawnEvent,
      "Withdrawn(uint256,uint256,uint256,uint256)",
      { force: req.query.refresh === "1" },
    );
    const nullifiers = [...new Set(logs.map((log) => String(log.args._spentNullifier)))];
    return sendJson(res, { nullifiers });
  } catch (error) {
    return sendJson(res, { error: error instanceof Error ? error.message : "Unable to index spent nullifiers" }, 502);
  }
});

app.get("/api/asp/proof/:label", async (req, res) => {
  const provider = process.env.ASP_API_URL || process.env.RELAYER_API_URL;
  if (!provider) return res.status(503).json({ error: "ASP_API_URL or RELAYER_API_URL is not configured" });
  try {
    const endpoint = process.env.ASP_API_URL
      ? `${provider.replace(/\/$/, "")}/proof?chainId=${encodeURIComponent(process.env.CHAIN_ID ?? "1")}&label=${encodeURIComponent(req.params.label)}`
      : `${provider.replace(/\/$/, "")}/relayer/asp/proof/${encodeURIComponent(req.params.label)}?chainId=${encodeURIComponent(process.env.CHAIN_ID ?? "1")}`;
    const response = await fetch(endpoint);
    return res.status(response.status).json(await response.json());
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "ASP provider unavailable" });
  }
});

/** Build a viem chain object for one EVM L2 destination. */
function evmL2Chain(chain) {
  return { id: chain.chainId, name: chain.chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [chain.rpcUrl] } } };
}

const l2NoteEvent = {
  type: "event",
  name: "L2Note",
  inputs: [
    { name: "_newCommitmentHashL2", type: "uint256", indexed: true },
    { name: "_ephemeralKey", type: "uint256[2]", indexed: false },
    { name: "_viewTag", type: "bytes1", indexed: true },
  ],
};
const noteReceivedEvent = {
  type: "event",
  name: "NoteReceived",
  inputs: [
    { name: "_commitment", type: "uint256", indexed: true },
    { name: "_value", type: "uint256", indexed: false },
  ],
};
const noteActivatedEvent = { ...noteReceivedEvent, name: "NoteActivated" };
const l2BackingAbi = [
  {
    type: "function",
    name: "activatedSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "tokensReceivedFromBridge",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
];
const scopeAbi = [{
  type: "function",
  name: "SCOPE",
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "uint256" }],
}];
const MULTICALL3_ADDRESS = process.env.MULTICALL3_ADDRESS ?? "0xcA11bde05977b3631167028862bE2a173976CA11";

function parseL2NoteLog(log) {
  const args = log.args ?? {};
  if (
    args._newCommitmentHashL2 === undefined ||
    !args._ephemeralKey ||
    args._viewTag === undefined ||
    log.blockNumber === undefined ||
    !log.transactionHash
  ) {
    throw new Error("Invalid L2Note log returned by RPC");
  }
  return {
    commitment: args._newCommitmentHashL2,
    ephemeralKey: [args._ephemeralKey[0], args._ephemeralKey[1]],
    viewTag: args._viewTag,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  };
}

function parseCommitmentValueLog(log, kind) {
  const args = log.args ?? {};
  if (
    args._commitment === undefined ||
    args._value === undefined ||
    log.blockNumber === undefined ||
    !log.transactionHash
  ) {
    throw new Error(`Invalid ${kind} log returned by RPC`);
  }
  return {
    commitment: args._commitment,
    value: args._value,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  };
}

async function readL1L2Notes() {
  return (await readL1Event(l2NoteEvent, "L2Note(uint256,uint256[2],bytes1)"))
    .map(parseL2NoteLog);
}

async function readEvmL2CommitmentEvents(chain, event, eventKey) {
  const logs = await eventIndex.read({
    chain: `evm:${chain.chainId}`,
    rpcUrl: chain.rpcUrl,
    address: chain.poolAddress,
    event,
    eventKey,
    fromBlock: BigInt(chain.deploymentBlock ?? "0"),
  });
  return logs.map((log) => parseCommitmentValueLog(log, event.name));
}

function buildScannableNotes(deliveries, received) {
  const values = new Map(received.map((event) => [event.commitment, event.value]));
  return deliveries.flatMap((note) => {
    const value = values.get(note.commitment);
    return value === undefined ? [] : [{
      commitment: note.commitment,
      ephemeralKey: note.ephemeralKey,
      viewTag: note.viewTag,
      value,
    }];
  });
}

function reconstructL2StateTree(activated) {
  const tree = new LeanIMT((left, right) => poseidon([left, right]));
  for (const event of activated) tree.insert(event.commitment);
  return tree;
}

function evmL2Scope(chain) {
  return rpcRuntime.cachedRead(
    `evm-scope:${chain.chainId}:${chain.poolAddress.toLowerCase()}`,
    () => evmClient(chain.chainId, chain.rpcUrl).readContract({
      address: chain.poolAddress,
      abi: scopeAbi,
      functionName: "SCOPE",
    }),
  );
}

app.get("/api/l2/:chain/index", async (req, res) => {
  const l1Rpc = process.env.PUBLIC_RPC_URL;
  const l1Pool = process.env.POOL_ADDRESS;
  let chain;
  try { chain = requireEvmL2(req.params.chain); } catch (e) { return res.status(e.status ?? 500).json({ configured: false, error: e.message, candidates: [], proofs: [] }); }
  if (!l1Rpc || !l1Pool) return res.json({ configured: false, candidates: [], proofs: [] });

  try {
    const [deliveries, received, activated, scope] = await Promise.all([
      readL1L2Notes(),
      readEvmL2CommitmentEvents(chain, noteReceivedEvent, "NoteReceived(uint256,uint256)"),
      readEvmL2CommitmentEvents(chain, noteActivatedEvent, "NoteActivated(uint256,uint256)"),
      evmL2Scope(chain),
    ]);
    const candidates = buildScannableNotes(deliveries, received);
    const tree = reconstructL2StateTree(activated);
    const stateRoot = tree.root ?? 0n;
    const proofs = activated.map((event) => {
      const index = tree.indexOf(event.commitment);
      return { commitment: event.commitment.toString(), index, depth: tree.depth, proof: index >= 0 ? tree.generateProof(index) : null };
    });
    return res.json({ configured: true, scope: scope.toString(), stateRoot: stateRoot.toString(), candidates: candidates.map((note) => ({ ...note, commitment: note.commitment.toString(), value: note.value.toString(), ephemeralKey: note.ephemeralKey.map((part) => part.toString()) })), proofs: JSON.parse(JSON.stringify(proofs, (_key, value) => typeof value === "bigint" ? value.toString() : value)) });
  } catch (error) {
    console.warn(`[L2 INDEX ERROR ${chain.key}]`, error instanceof Error ? error.stack : error);
    return res.status(502).json({ configured: true, error: error instanceof Error ? error.message : "Unable to index Mode-3 notes", candidates: [], proofs: [] });
  }
});

app.get("/api/l2/:chain/config", async (req, res) => {
  let chain;
  try { chain = requireEvmL2(req.params.chain); } catch (e) { return res.status(e.status ?? 500).json({ error: e.message }); }
  try {
    const scope = await evmL2Scope(chain);
    return res.json({ configured: Boolean(chain.relayerKey), chainId: chain.chainId, chainName: chain.chainName, poolAddress: chain.poolAddress, scope: scope.toString(), relayerAddress: chain.relayerKey ? privateKeyToAccount(chain.relayerKey).address : null });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "Unable to read L2 configuration" });
  }
});

app.get("/api/l2/:chain/status/:commitment", async (req, res) => {
  let chain;
  try { chain = requireEvmL2(req.params.chain); } catch (e) { return res.status(e.status ?? 500).json({ error: e.message }); }
  try {
    const client = evmClient(chain.chainId, chain.rpcUrl);
    const abi = [
      { type: "function", name: "receivedCommitments", stateMutability: "view", inputs: [{ name: "commitment", type: "uint256" }], outputs: [{ type: "bool" }] },
      { type: "function", name: "pendingValue", stateMutability: "view", inputs: [{ name: "commitment", type: "uint256" }], outputs: [{ type: "uint256" }] },
      { type: "function", name: "currentRoot", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    ];
    const commitment = BigInt(req.params.commitment);
    const [received, pendingValue, currentRoot] = await client.multicall({
      allowFailure: false,
      multicallAddress: MULTICALL3_ADDRESS,
      contracts: [
        { address: chain.poolAddress, abi, functionName: "receivedCommitments", args: [commitment] },
        { address: chain.poolAddress, abi, functionName: "pendingValue", args: [commitment] },
        { address: chain.poolAddress, abi, functionName: "currentRoot" },
      ],
    });
    return res.json({ received, pendingValue: pendingValue.toString(), currentRoot: currentRoot.toString(), state: !received ? "bridge-pending" : pendingValue > 0n ? "received-pending-activation" : "activated" });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "Unable to read L2 status" });
  }
});

app.post("/api/l2/:chain/activate", async (req, res) => {
  let chain;
  try { chain = requireEvmL2(req.params.chain); } catch (e) { return res.status(e.status ?? 500).json({ error: e.message }); }
  if (!chain.relayerKey) return res.status(503).json({ error: `${chain.chainName} activation is not configured` });
  try {
    const interactions = getSdk().createContractInstance(chain.rpcUrl, evmL2Chain(chain), chain.poolAddress, chain.relayerKey);
    const transaction = await l2TransactionQueue.run(evmSignerQueueKey(chain), async () => {
      const submitted = await interactions.activateNote(chain.poolAddress, BigInt(req.body.commitment));
      const receipt = await evmClient(chain.chainId, chain.rpcUrl).waitForTransactionReceipt({ hash: submitted.hash });
      if (receipt.status !== "success") throw new Error(`activation transaction ${submitted.hash} reverted`);
      return submitted;
    });
    return res.json({ hash: transaction.hash });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "L2 activation failed" });
  }
});

app.post("/api/l2/:chain/withdraw", async (req, res) => {
  let chain;
  try { chain = requireEvmL2(req.params.chain); } catch (e) { return res.status(e.status ?? 500).json({ error: e.message }); }
  if (!chain.relayerKey) return res.status(503).json({ error: `${chain.chainName} withdrawal is not configured` });
  try {
    const interactions = getSdk().createContractInstance(chain.rpcUrl, evmL2Chain(chain), chain.poolAddress, chain.relayerKey);
    const transaction = await l2TransactionQueue.run(evmSignerQueueKey(chain), async () => {
      const submitted = await interactions.withdrawL2(chain.poolAddress, req.body.withdrawal, req.body.proof);
      const receipt = await evmClient(chain.chainId, chain.rpcUrl).waitForTransactionReceipt({ hash: submitted.hash });
      if (receipt.status !== "success") throw new Error(`withdrawal transaction ${submitted.hash} reverted`);
      return submitted;
    });
    return res.json({ hash: transaction.hash });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "L2 withdrawal failed" });
  }
});

/**
 * The L1 pool this Starknet pool will accept notes from.
 *
 * `receive_note` asserts `from_address == l1_pool`, and `l1_pool` is IMMUTABLE
 * (set in the constructor). If our L1 pool is not the bound one, a Starknet relay
 * is a trap: StarkGate still delivers the ETH, but the note message reverts with
 * `NotL1Pool` — so the value lands in the Cairo pool with NO note that can ever
 * claim it. That is unrecoverable, so we check before offering Starknet at all.
 *
 * There is no `l1_pool()` getter in the pool's interface, but it is a plain
 * storage var, so its slot is `sn_keccak("l1_pool")`.
 */
async function getStarknetBoundL1Pool(provider, poolAddress) {
  const slot = snHash.starknetKeccak("l1_pool").toString(16);
  // Retry so a transient RPC blip (Infura throws -32603 under load) does not
  // fail-close the whole destination: a single throw here leaves `l1PoolMatches`
  // null, which the UI renders as "STARKNET DISABLED — unreachable". Pin to
  // `latest` rather than the default `pending`: `l1_pool` is immutable so they
  // agree, and some nodes (Alchemy v0.10) reject `pending` with -32602.
  const raw = await withRetry(() => provider.getStorageAt(poolAddress, `0x${slot}`, "latest"));
  return BigInt(raw);
}

function cachedStarknetBoundL1Pool(provider, config) {
  return rpcRuntime.cachedRead(
    `starknet-bound-l1:${config.chainId}:${config.poolAddress.toLowerCase()}`,
    () => getStarknetBoundL1Pool(provider, config.poolAddress),
  );
}

function getStarknetScope(provider, config) {
  return rpcRuntime.cachedRead(
    `starknet-scope:${config.chainId}:${config.poolAddress.toLowerCase()}`,
    async () => {
      const [low, high] = await withRetry(() => provider.callContract({
        contractAddress: config.poolAddress,
        entrypoint: "scope",
        calldata: [],
      }));
      return fromU256(low, high);
    },
  );
}

function getStarknetRoot(provider, config) {
  return rpcRuntime.cachedRead(
    `starknet-root:${config.chainId}:${config.poolAddress.toLowerCase()}`,
    async () => {
      const [low, high] = await withRetry(() => provider.callContract({
        contractAddress: config.poolAddress,
        entrypoint: "current_root",
        calldata: [],
      }));
      return fromU256(low, high);
    },
    { maxAgeMs: Number(process.env.RPC_HEAD_TTL_MS ?? 2500) },
  );
}

app.get("/api/starknet/config", async (_req, res) => {
  const config = getStarknetConfig();
  if (!config.rpcUrl || !config.poolAddress) return res.status(503).json({ error: "Starknet destination is not configured" });

  let boundL1Pool = null;
  let l1PoolMatches = null; // null = could not determine
  try {
    const provider = getStarknetProvider(config);
    boundL1Pool = await cachedStarknetBoundL1Pool(provider, config);
    const ours = process.env.POOL_ADDRESS ? BigInt(process.env.POOL_ADDRESS) : null;
    l1PoolMatches = ours !== null ? boundL1Pool === ours : null;
  } catch (error) {
    console.warn("[STARKNET CONFIG] could not read bound l1_pool:", error instanceof Error ? error.message : error);
  }

  return sendJson(res, {
    // Both the relayer keys AND the L1-pool binding must be right, or the
    // destination is not safely usable.
    configured: Boolean(config.privateKey && config.relayerAddress) && l1PoolMatches === true,
    relayerReady: Boolean(config.privateKey && config.relayerAddress),
    l1PoolMatches,
    boundL1Pool: boundL1Pool === null ? null : `0x${boundL1Pool.toString(16).padStart(40, "0")}`,
    ourL1Pool: process.env.POOL_ADDRESS ?? null,
    chainId: config.chainId,
    chainName: config.chainName,
    poolAddress: config.poolAddress,
    assetAddress: config.assetAddress,
    relayerAddress: config.relayerAddress || null,
  });
});

/** A Cairo `u256` arrives as two felts: [low, high]. */
const fromU256 = (low, high) => BigInt(low) + (BigInt(high) << 128n);

/**
 * Read a Cairo pool event across all pages.
 *
 * `commitment` is `#[key]`-tagged in the Cairo event, so it lands in `keys`
 * (as a u256 = two felts, after the selector) while `value` lands in `data`.
 */
async function getStarknetEvents(provider, poolAddress, eventName) {
  const selector = snHash.getSelectorFromName(eventName);
  const config = getStarknetConfig();
  const events = await starknetEventIndex.read({
    rpcUrl: config.rpcUrl,
    provider,
    address: poolAddress,
    eventName,
    selector,
    fromBlock: Number(process.env.STARKNET_DEPLOYMENT_BLOCK ?? 0),
  });
  return events.map((event) => ({
    commitment: fromU256(event.keys[1], event.keys[2]),
    value: fromU256(event.data[0], event.data[1]),
  }));
}

/** Public events contain everything needed to activate; no recipient key material is involved. */
async function refreshEvmAutomaticActivations(chain) {
  const client = evmClient(chain.chainId, chain.rpcUrl);
  const [received, activated, activatedSupply, tokensReceived] = await Promise.all([
    readEvmL2CommitmentEvents(chain, noteReceivedEvent, "NoteReceived(uint256,uint256)"),
    readEvmL2CommitmentEvents(chain, noteActivatedEvent, "NoteActivated(uint256,uint256)"),
    client.readContract({ address: chain.poolAddress, abi: l2BackingAbi, functionName: "activatedSupply" }),
    client.readContract({ address: chain.poolAddress, abi: l2BackingAbi, functionName: "tokensReceivedFromBridge" }),
  ]);
  const planned = planBackedActivations({ received, activated, activatedSupply, tokensReceived });
  if (!planned.length) return;

  const interactions = getSdk().createContractInstance(
    chain.rpcUrl,
    evmL2Chain(chain),
    chain.poolAddress,
    chain.relayerKey,
  );
  for (const note of planned) {
    await l2TransactionQueue.run(evmSignerQueueKey(chain), async () => {
      const transaction = await interactions.activateNote(chain.poolAddress, note.commitment);
      const receipt = await client.waitForTransactionReceipt({ hash: transaction.hash });
      if (receipt.status !== "success") throw new Error(`activation transaction ${transaction.hash} reverted`);
      console.log(`[l2-auto-activate] ${chain.chainName} activated ${note.commitment} (${transaction.hash})`);
    });
  }
}

async function refreshStarknetAutomaticActivations(config) {
  const provider = getStarknetProvider(config);
  const [received, activated, tokenParts] = await Promise.all([
    getStarknetEvents(provider, config.poolAddress, "NoteReceived"),
    getStarknetEvents(provider, config.poolAddress, "NoteActivated"),
    withRetry(() => provider.callContract({
      contractAddress: config.poolAddress,
      entrypoint: "tokens_received_from_bridge",
    })),
  ]);
  const tokensReceived = fromU256(tokenParts[0], tokenParts[1]);
  const activatedSupply = activated.reduce((total, event) => total + event.value, 0n);
  const planned = planBackedActivations({ received, activated, activatedSupply, tokensReceived });
  if (!planned.length) return;

  const account = new Account(provider, config.relayerAddress, config.privateKey);
  for (const note of planned) {
    await l2TransactionQueue.run(starknetSignerQueueKey(config), async () => {
      const response = await account.execute({
        contractAddress: config.poolAddress,
        entrypoint: "activate_note",
        calldata: starknetU256(note.commitment),
      });
      await provider.waitForTransaction(response.transaction_hash);
      console.log(`[l2-auto-activate] ${config.chainName} activated ${note.commitment} (${response.transaction_hash})`);
    });
  }
}

/**
 * The Starknet twin of `/api/l2/:chain/index`.
 *
 * A recipient cannot scan for a Starknet note without this: `C_dest` folds the
 * value in, so confirming a note needs `(ephemeralKey, viewTag)` — which are
 * emitted on L1, the same for every destination — joined with the cleartext
 * `value`, which only exists once the tokens land on Starknet.
 *
 * The Cairo pool hashes its tree with `garaga::hashes::poseidon_bn254`, i.e. the
 * same circomlib-compatible Poseidon as the OP pool and the `withdrawL2` circuit,
 * so the tree reconstructs identically.
 */
app.get("/api/starknet/index", async (_req, res) => {
  const config = getStarknetConfig();
  const l1Rpc = process.env.PUBLIC_RPC_URL;
  const l1Pool = process.env.POOL_ADDRESS;
  if (!config.rpcUrl || !config.poolAddress || !l1Rpc || !l1Pool) {
    return sendJson(res, { configured: false, candidates: [], proofs: [] });
  }
  try {
    const provider = getStarknetProvider(config);
    const [deliveries, received, activated, scope] = await Promise.all([
      // Stealth material — emitted on L1 regardless of destination chain.
      readL1L2Notes(),
      getStarknetEvents(provider, config.poolAddress, "NoteReceived"),
      getStarknetEvents(provider, config.poolAddress, "NoteActivated"),
      getStarknetScope(provider, config),
    ]);

    const candidates = buildScannableNotes(deliveries, received);
    const tree = reconstructL2StateTree(activated);

    return sendJson(res, {
      configured: true,
      scope,
      stateRoot: tree.root ?? 0n,
      candidates,
      proofs: activated.map((event) => {
        const index = tree.indexOf(event.commitment);
        return {
          commitment: event.commitment,
          index,
          depth: tree.depth,
          proof: index >= 0 ? tree.generateProof(index) : null,
        };
      }),
    });
  } catch (error) {
    console.warn("[STARKNET INDEX ERROR]", error instanceof Error ? error.stack : error);
    return sendJson(res, { configured: true, error: error instanceof Error ? error.message : "Unable to index Starknet notes", candidates: [], proofs: [] }, 502);
  }
});

app.get("/api/starknet/status/:commitment", async (req, res) => {
  const config = getStarknetConfig();
  if (!config.rpcUrl || !config.poolAddress) return res.status(503).json({ error: "Starknet destination is not configured" });
  try {
    const provider = getStarknetProvider(config);
    const commitment = BigInt(req.params.commitment);
    const [[pendingLow, pendingHigh], root, scope, receivedEvents, activatedEvents] = await Promise.all([
      withRetry(() => provider.callContract({
        contractAddress: config.poolAddress,
        entrypoint: "pending_value",
        calldata: starknetU256(commitment),
      })),
      getStarknetRoot(provider, config),
      getStarknetScope(provider, config),
      getStarknetEvents(provider, config.poolAddress, "NoteReceived"),
      getStarknetEvents(provider, config.poolAddress, "NoteActivated"),
    ]);
    const pendingValue = BigInt(pendingLow) + (BigInt(pendingHigh) << 128n);
    const received = receivedEvents.some((event) => event.commitment === commitment);
    const activated = activatedEvents.some((event) => event.commitment === commitment);
    return res.json({
      received,
      pendingValue: pendingValue.toString(),
      currentRoot: root.toString(),
      scope: scope.toString(),
      state: activated ? "activated" : pendingValue > 0n ? "received-pending-activation" : "bridge-pending",
    });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "Unable to read Starknet status" });
  }
});

app.post("/api/starknet/activate", async (req, res) => {
  const config = getStarknetConfig();
  if (!config.rpcUrl || !config.poolAddress || !config.privateKey || !config.relayerAddress) return res.status(503).json({ error: "Starknet relayer is not configured" });
  try {
    const provider = getStarknetProvider(config);
    const account = new Account(provider, config.relayerAddress, config.privateKey);
    const response = await l2TransactionQueue.run(starknetSignerQueueKey(config), async () => {
      const submitted = await account.execute({ contractAddress: config.poolAddress, entrypoint: "activate_note", calldata: starknetU256(req.body.commitment) });
      await provider.waitForTransaction(submitted.transaction_hash);
      return submitted;
    });
    return res.json({ hash: response.transaction_hash });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Starknet activation failed" });
  }
});

/**
 * Turn a snarkjs Groth16 proof into the felt calldata the Cairo verifier expects.
 *
 * This used to be a manual step: the UI made the user run the `garaga` PYTHON CLI
 * and paste a felt array into a textarea. Garaga ships the same logic as a WASM
 * package, so the conversion happens here and the recipient never sees it.
 */
let garagaReady;
async function toGaragaCalldata(proof, publicSignals) {
  const garaga = await import("garaga");
  garagaReady ??= garaga.init();
  await garagaReady;

  const vkeyPath = fileURLToPath(
    new URL("../../packages/circuits/build/withdrawL2/groth16_vkey.json", import.meta.url),
  );
  const vkey = JSON.parse(readFileSync(vkeyPath, "utf8"));

  return garaga.getGroth16CallData(
    garaga.parseGroth16ProofFromObject({ ...proof, public_inputs: publicSignals.map(String) }),
    garaga.parseGroth16VerifyingKeyFromObject(vkey),
    0, // BN254
  ).map(String);
}

app.post("/api/starknet/calldata", async (req, res) => {
  const { proof, publicSignals } = req.body ?? {};
  if (!proof || !Array.isArray(publicSignals)) {
    return sendJson(res, { error: "proof and publicSignals are required" }, 400);
  }
  try {
    return sendJson(res, { calldata: await toGaragaCalldata(proof, publicSignals) });
  } catch (error) {
    return sendJson(res, { error: error instanceof Error ? error.message : "Unable to build Garaga calldata" }, 500);
  }
});

app.post("/api/starknet/withdraw", async (req, res) => {
  const config = getStarknetConfig();
  if (!config.rpcUrl || !config.poolAddress || !config.privateKey || !config.relayerAddress) return res.status(503).json({ error: "Starknet relayer is not configured" });
  const { withdrawal, proof, publicSignals } = req.body ?? {};
  // Accept a raw proof and do the Garaga conversion here; `proofCalldata` stays
  // supported so the pre-existing manual/CLI path keeps working.
  let { proofCalldata } = req.body ?? {};
  if (!proofCalldata && proof && Array.isArray(publicSignals)) {
    try {
      proofCalldata = await toGaragaCalldata(proof, publicSignals);
    } catch (error) {
      return sendJson(res, { error: error instanceof Error ? error.message : "Unable to build Garaga calldata" }, 500);
    }
  }
  if (!withdrawal || !Array.isArray(proofCalldata) || !proofCalldata.length) return res.status(400).json({ error: "withdrawal and a proof (or Garaga proofCalldata) are required" });
  try {
    const provider = getStarknetProvider(config);
    const account = new Account(provider, config.relayerAddress, config.privateKey);
    const calldata = [
      withdrawal.processooor,
      withdrawal.recipient,
      withdrawal.feeRecipient,
      ...starknetU256(withdrawal.relayFeeBPS ?? 0),
      proofCalldata.length.toString(),
      ...proofCalldata.map(String),
    ];
    const response = await l2TransactionQueue.run(starknetSignerQueueKey(config), async () => {
      const submitted = await account.execute({ contractAddress: config.poolAddress, entrypoint: "withdraw", calldata });
      await provider.waitForTransaction(submitted.transaction_hash);
      return submitted;
    });
    return res.json({ hash: response.transaction_hash });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Starknet withdrawal failed" });
  }
});

app.post("/api/proofs/commitment", async (req, res) => {
  try {
    const { value, label, nullifier, secret } = req.body ?? {};
    if ([value, label, nullifier, secret].some((item) => item === undefined)) {
      return res.status(400).json({ error: "value, label, nullifier and secret are required" });
    }

    const proof = await getSdk().proveCommitment(
      BigInt(value),
      BigInt(label),
      BigInt(nullifier),
      BigInt(secret),
    );
    return res.json({ proof });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Commitment proof failed",
      hint: "Circuit artifacts must be present in the SDK distribution.",
    });
  }
});

app.post("/api/proofs/verify", async (req, res) => {
  try {
    const valid = await getSdk().verifyCommitment(req.body);
    return res.json({ valid });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Verification failed" });
  }
});

app.post("/api/relay", async (req, res) => {
  const required = ["withdrawal", "proof", "scope"];
  if (required.some((key) => req.body?.[key] === undefined)) {
    return res.status(400).json({ error: "withdrawal, proof and scope are required" });
  }

  if (!process.env.RELAYER_RPC_URL || !process.env.RELAYER_PRIVATE_KEY || !process.env.ENTRYPOINT_ADDRESS) {
    return res.status(503).json({
      error: "Relay submission is not configured",
      required: ["RELAYER_RPC_URL", "RELAYER_PRIVATE_KEY", "ENTRYPOINT_ADDRESS"],
    });
  }

  try {
    const chain = {
      id: Number(process.env.CHAIN_ID ?? 1),
      name: process.env.CHAIN_NAME ?? "Configured chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [process.env.RELAYER_RPC_URL] } },
    };
    const interactions = getSdk().createContractInstance(
      process.env.RELAYER_RPC_URL,
      chain,
      process.env.ENTRYPOINT_ADDRESS,
      process.env.RELAYER_PRIVATE_KEY,
    );
    const transaction = await interactions.relay(
      req.body.withdrawal,
      req.body.proof,
      BigInt(req.body.scope),
    );
    return res.json({ hash: transaction.hash });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Relay failed" });
  }
});

function automaticActivationDestinations() {
  if (process.env.L2_AUTO_ACTIVATE === "false") return [];
  const evm = getEvmL2s()
    .filter((chain) => chain.relayerKey && chain.chainId > 0)
    .map((chain) => ({ id: `evm:${chain.key}`, label: chain.chainName, family: "evm", chain }));
  const starknet = getStarknetConfig();
  if (starknet.rpcUrl && starknet.poolAddress && starknet.relayerAddress && starknet.privateKey) {
    evm.push({ id: "starknet", label: starknet.chainName, family: "starknet", config: starknet });
  }
  return evm;
}

const automaticNoteActivator = new AutomaticNoteActivator({
  getDestinations: automaticActivationDestinations,
  refresh: (destination) => destination.family === "evm"
    ? refreshEvmAutomaticActivations(destination.chain)
    : refreshStarknetAutomaticActivations(destination.config),
  intervalMs: Number(process.env.L2_AUTO_ACTIVATE_POLL_MS ?? 10_000),
});

app.listen(port, () => {
  console.log(`F5 API listening on :${port}`);
  automaticNoteActivator.start();
});

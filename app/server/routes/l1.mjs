/**
 * L1 pool read endpoints: config, activity, deposits, state proofs, spent nullifiers.
 *
 * All read-only. The one L1 *write* — the entrypoint relay — is a proxy to the
 * relayer and lives in `routes/relay.mjs`.
 */
import { Router } from "express";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon } from "maci-crypto/build/ts/hashing.js";
import { getEvmL2s, getL1, l1Indexable } from "../config.mjs";
import {
  getDepositEvents,
  l1Client,
  readL1PoolEvents,
  readL1SpendEvents,
} from "../evm-reads.mjs";
import { errorMessage, handler, parseCommitment, sendJson } from "../http.mjs";
import { l1SpendSnapshot } from "../l1-spend-snapshot.mjs";
import {
  assetConfigAbi,
  currentRootAbi,
  parseWithdrawalLog,
} from "../pool-events.mjs";
import { rpcRuntime } from "../rpc-runtime.mjs";

export const l1Router = Router();

l1Router.get("/config", async (_req, res) => {
  const l1 = getL1();
  const config = {
    chainId: l1.chainId,
    chainName: l1.chainName,
    rpcUrl: l1.rpcUrl,
    poolAddress: l1.poolAddress,
    scope: l1.scope,
    asset: l1.asset,
    symbol: l1.symbol,
    decimals: l1.decimals,
    minDepositWei: process.env.MIN_DEPOSIT_WEI ?? "0",
    maxDepositWei: ((1n << 128n) - 1n).toString(),
    vettingFeeBps: Number(process.env.VETTING_FEE_BPS ?? 0),
    explorerUrl: l1.explorerUrl,
    // The EVM L2 destinations the client should scan and offer, each with its route
    // key. Starknet is advertised separately via /api/starknet/config.
    l2Chains: getEvmL2s().map((c) => ({
      key: c.key, chainId: c.chainId, chainName: c.chainName, explorerUrl: c.explorerUrl,
    })),
  };

  if (!config.rpcUrl || !l1.entrypointAddress || !config.asset) return res.json(config);

  try {
    // Live values win over the env defaults above, but a read failure must not take
    // the whole config endpoint down — the client can still deposit with the static
    // values, and the alternative is a blank UI whenever the RPC hiccups.
    const result = await rpcRuntime.cachedRead(
      `asset-config:${config.chainId}:${l1.entrypointAddress.toLowerCase()}:${config.asset.toLowerCase()}`,
      () =>
        l1Client(config.rpcUrl).readContract({
          address: l1.entrypointAddress,
          abi: assetConfigAbi,
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
    console.warn("[CONFIG WARNING] Could not read live asset configuration:", errorMessage(error, error));
    return res.json(config);
  }
});

l1Router.get("/activity", async (_req, res) => {
  if (!l1Indexable()) return res.json({ configured: false, deposits: [], withdrawals: [] });
  try {
    const [deposits, withdrawalLogs] = await Promise.all([
      getDepositEvents(),
      readL1SpendEvents().then(({ withdrawals }) => withdrawals),
    ]);
    const withdrawals = withdrawalLogs.map(parseWithdrawalLog);
    // sendJson, not res.json: these events carry bigints and JSON.stringify throws.
    return sendJson(res, {
      configured: true,
      deposits: deposits.slice(-12),
      withdrawals: withdrawals.slice(-12),
    });
  } catch (error) {
    return sendJson(
      res,
      { configured: true, error: errorMessage(error, "Unable to read activity"), deposits: [], withdrawals: [] },
      502,
    );
  }
});

l1Router.get(
  "/deposits/:hash",
  handler(
    async (req, res) => {
      // The caller is polling for a deposit that JUST landed, so the cursor must
      // advance — a plain cached read would never see it.
      const deposits = await getDepositEvents();
      const event = deposits.find(
        (item) => item.transactionHash.toLowerCase() === req.params.hash.toLowerCase(),
      );
      if (!event) return sendJson(res, { status: "pending" }, 202);
      return sendJson(res, { status: "confirmed", event });
    },
    { fallback: "Unable to reconcile deposit" },
  ),
);

/**
 * Every `Deposited` event in the pool.
 *
 * This is what makes the local note vault a CACHE rather than the source of truth:
 * deposit secrets are `Poseidon(master, scope, index)`, so a client holding the
 * mnemonic can walk indices, derive each precommitment, and match it here —
 * recovering every note without any local state. It is public data (the whole pool's
 * deposits), and the matching happens entirely client-side, so asking for it reveals
 * nothing about who is asking.
 */
l1Router.get(
  "/l1/deposits",
  handler(
    async (req, res) => {
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
    },
    { fallback: "Unable to index deposits" },
  ),
);

/**
 * Every `Withdrawn` event in the pool, unabridged (unlike `/activity`, which
 * truncates to the 12 most recent for the dashboard).
 *
 * A change note left behind by a partial withdrawal has no creation-time event
 * of its own — `newCommitmentHashL1` only becomes public here, on the SAME
 * event that burns its parent's nullifier. That is what lets a client walk its
 * own known notes' spend history and reconstruct every change note after a
 * wiped browser, the same way `/l1/deposits` lets it reconstruct deposits.
 */
l1Router.get(
  "/l1/withdrawals",
  handler(
    async (req, res) => {
      const { withdrawals: logs } = await readL1SpendEvents({
        force: req.query.refresh === "1",
      });
      const withdrawals = logs.map(parseWithdrawalLog);
      return sendJson(res, {
        withdrawals: withdrawals.map((w) => ({
          newCommitment: w.newCommitment,
          withdrawnValue: w.withdrawn,
          spentNullifierHash: w.spentNullifier,
          blockNumber: w.blockNumber,
          transactionHash: w.transactionHash,
        })),
      });
    },
    { fallback: "Unable to index withdrawals" },
  ),
);

l1Router.get("/l1/state-proof/:commitment", async (req, res) => {
  if (!l1Indexable()) return res.status(503).json({ error: "L1 pool indexing is not configured" });
  const { poolAddress, rpcUrl } = getL1();
  try {
    const logs = (await readL1PoolEvents()).filter((log) => log.eventName === "LeafInserted");
    // Sort a copy: `logs` is the cache's own array and must not be reordered in place.
    const ordered = [...logs].sort((a, b) => Number(a.args._index - b.args._index));
    const leaves = ordered.map((log) => log.args._leaf);
    const commitment = parseCommitment(req.params.commitment);

    // An empty pool has no leaves, and LeanIMT's insertMany rejects an empty array
    // with the singularly unhelpful "There are no leaves to add". Answer the question
    // that was actually asked — the commitment is not in the tree — rather than
    // leaking that internal error. This is the normal state of a freshly deployed
    // pool, and of a vault still holding notes from a previous deployment.
    if (leaves.length === 0) {
      return res.status(404).json({
        error:
          `The pool at ${poolAddress} has no deposits yet, so no commitment can be proven against it. ` +
          "If this note came from an earlier deployment it cannot be spent here. Hit RECOVER to rebuild " +
          "your notes from the current pool.",
      });
    }

    const tree = new LeanIMT((left, right) => poseidon([left, right]));
    tree.insertMany(leaves);
    const index = tree.indexOf(commitment);
    if (index < 0) return res.status(404).json({ error: "Commitment is not in the L1 state tree" });

    const proof = tree.generateProof(index);
    const currentRoot = await l1Client(rpcUrl).readContract({
      address: poolAddress,
      abi: currentRootAbi,
      functionName: "currentRoot",
    });
    // A proof against a stale root is rejected on-chain. Say so explicitly rather
    // than handing back a proof that cannot be used.
    if (tree.root !== currentRoot) {
      return res.status(409).json({
        error: "Indexed L1 state root is stale",
        indexedRoot: tree.root.toString(),
        onchainRoot: currentRoot.toString(),
      });
    }

    return res.json({
      root: proof.root.toString(),
      depth: tree.depth,
      proof: {
        index: proof.index,
        siblings: proof.siblings.map((item) => item.toString()),
        root: proof.root.toString(),
      },
    });
  } catch (error) {
    return res
      .status(error.status ?? 502)
      .json({ error: errorMessage(error, "Unable to reconstruct L1 state tree") });
  }
});

/**
 * The shared, process-wide snapshot of L1 notes the pool has already spent.
 *
 * Withdrawal events identify the burned nullifier; ragequits expose the spent
 * commitment instead. Both complete public sets are returned so matching remains
 * client-side and private. Crucially, this handler performs no RPC call: the
 * once-per-minute background scanner refreshes the snapshot for every user.
 */
l1Router.get("/l1/spent-nullifiers", async (_req, res) => {
  if (!l1Indexable()) return res.status(503).json({ error: "L1 pool indexing is not configured" });
  const snapshot = l1SpendSnapshot.snapshot();
  if (!snapshot || !l1SpendSnapshot.isFresh()) {
    return res.status(503).json({
      error: !snapshot
        ? l1SpendSnapshot.error
          ? errorMessage(l1SpendSnapshot.error, "L1 spent-note snapshot unavailable")
          : "L1 spent-note snapshot is warming up"
        : "L1 spent-note snapshot is stale",
    });
  }
  res.set("cache-control", "public, max-age=5, stale-while-revalidate=55");
  return sendJson(res, snapshot);
});

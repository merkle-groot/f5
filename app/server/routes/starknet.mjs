/**
 * Starknet destination endpoints — the Cairo twin of `routes/l2.mjs`.
 *
 * Same shape, different family: felt pairs instead of 256-bit words, no Multicall3,
 * and one extra safety check (`l1_pool`) that has no EVM equivalent.
 */
import { Router } from "express";
import { getL1, getStarknetConfig, starknetConfigured, STARKNET_DESTINATION_KEY } from "../config.mjs";
import { destinationSigner } from "../destinations.mjs";
import { readL1L2Notes } from "../evm-reads.mjs";
import { errorMessage, sendJson } from "../http.mjs";
import { buildScannableNotes, reconstructL2StateTree } from "../pool-events.mjs";
import { proxyToRelayer } from "../relayer-proxy.mjs";
import {
  getBoundL1Pool,
  getNoteLifecycleEvents,
  getPendingValue,
  getRoot,
  getScope,
  getStarknetProvider,
} from "../starknet-reads.mjs";

export const starknetRouter = Router();

starknetRouter.get("/config", async (_req, res) => {
  if (!starknetConfigured()) {
    return res.status(503).json({ error: "Starknet destination is not configured" });
  }
  const config = getStarknetConfig();

  let boundL1Pool = null;
  let l1PoolMatches = null; // null = could not determine
  try {
    boundL1Pool = await getBoundL1Pool(getStarknetProvider(config), config);
    const ours = getL1().poolAddress ? BigInt(getL1().poolAddress) : null;
    l1PoolMatches = ours !== null ? boundL1Pool === ours : null;
  } catch (error) {
    console.warn("[STARKNET CONFIG] could not read bound l1_pool:", errorMessage(error, error));
  }

  let signer = { configured: false, relayerAddress: null };
  try {
    signer = await destinationSigner(STARKNET_DESTINATION_KEY);
  } catch (error) {
    console.warn("[STARKNET CONFIG] could not read relayer destination:", errorMessage(error, error));
  }

  return sendJson(res, {
    // Both a relayer that can sign AND a correct L1-pool binding are required, or the
    // destination is not safely usable — see `getBoundL1Pool` for why a mismatch
    // strands value unrecoverably.
    configured: Boolean(signer.configured) && l1PoolMatches === true,
    relayerReady: Boolean(signer.configured),
    l1PoolMatches,
    boundL1Pool: boundL1Pool === null ? null : `0x${boundL1Pool.toString(16).padStart(40, "0")}`,
    ourL1Pool: getL1().poolAddress || null,
    chainId: config.chainId,
    chainName: config.chainName,
    explorerUrl: config.explorerUrl,
    poolAddress: config.poolAddress,
    assetAddress: config.assetAddress,
    relayerAddress: signer.relayerAddress ?? null,
  });
});

/**
 * The Starknet twin of `/api/l2/:chain/index`.
 *
 * A recipient cannot scan for a Starknet note without this: `C_dest` folds the value
 * in, so confirming a note needs `(ephemeralKey, viewTag)` — which are emitted on L1,
 * the same for every destination — joined with the cleartext `value`, which only
 * exists once the tokens land on Starknet.
 */
starknetRouter.get("/index", async (_req, res) => {
  const config = getStarknetConfig();
  const l1 = getL1();
  if (!starknetConfigured() || !l1.rpcUrl || !l1.poolAddress) {
    return sendJson(res, { configured: false, candidates: [], proofs: [] });
  }
  try {
    const provider = getStarknetProvider(config);
    const [deliveries, lifecycle, scope] = await Promise.all([
      // Stealth material — emitted on L1 regardless of destination chain.
      readL1L2Notes(),
      getNoteLifecycleEvents(provider, config),
      getScope(provider, config),
    ]);
    const { received, activated } = lifecycle;

    const tree = reconstructL2StateTree(activated);
    return sendJson(res, {
      configured: true,
      scope,
      stateRoot: tree.root ?? 0n,
      candidates: buildScannableNotes(deliveries, received),
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
    return sendJson(
      res,
      { configured: true, error: errorMessage(error, "Unable to index Starknet notes"), candidates: [], proofs: [] },
      502,
    );
  }
});

starknetRouter.get("/status/:commitment", async (req, res) => {
  if (!starknetConfigured()) {
    return res.status(503).json({ error: "Starknet destination is not configured" });
  }
  const config = getStarknetConfig();
  try {
    const provider = getStarknetProvider(config);
    const commitment = BigInt(req.params.commitment);
    const [pendingValue, root, scope, lifecycle] = await Promise.all([
      getPendingValue(provider, config, commitment),
      getRoot(provider, config),
      getScope(provider, config),
      getNoteLifecycleEvents(provider, config),
    ]);
    const { received: receivedEvents, activated: activatedEvents } = lifecycle;
    return res.json({
      received: receivedEvents.some((event) => event.commitment === commitment),
      pendingValue: pendingValue.toString(),
      currentRoot: root.toString(),
      scope: scope.toString(),
      state: activatedEvents.some((event) => event.commitment === commitment)
        ? "activated"
        : pendingValue > 0n
          ? "received-pending-activation"
          : "bridge-pending",
    });
  } catch (error) {
    return res.status(502).json({ error: errorMessage(error, "Unable to read Starknet status") });
  }
});

starknetRouter.post(
  "/activate",
  proxyToRelayer(() => `/relayer/destinations/${STARKNET_DESTINATION_KEY}/activate`, {
    unavailable: "Starknet activation failed",
  }),
);

/**
 * The Garaga proof->felt-calldata conversion lives in the relayer, alongside the
 * signer that submits it.
 *
 * The old handler also accepted a pre-converted `proofCalldata`, a leftover from when
 * the recipient ran the `garaga` Python CLI by hand. That is deliberately not carried
 * over: the relayer verifies the `withdrawL2` proof before spending gas, and it cannot
 * verify anything from already-flattened calldata. Only a real proof is accepted now.
 */
starknetRouter.post(
  "/withdraw",
  proxyToRelayer(() => `/relayer/destinations/${STARKNET_DESTINATION_KEY}/withdraw`, {
    unavailable: "Starknet withdrawal failed",
  }),
);

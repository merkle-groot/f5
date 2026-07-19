/**
 * EVM L2 destination endpoints.
 *
 * Reads are served here; the two writes (`activate`, `withdraw`) are proxied to the
 * relayer untouched. `:chain` is the same route key the relayer registers its
 * destinations under, so a key that works here works there.
 */
import { Router } from "express";
import { getL1, requireEvmL2 } from "../config.mjs";
import { destinationSigner } from "../destinations.mjs";
import { evmL2Scope, multicall, readEvmL2NoteEvents, readL1L2Notes } from "../evm-reads.mjs";
import { errorMessage } from "../http.mjs";
import {
  buildScannableNotes,
  l2StatusAbi,
  reconstructL2StateTree,
} from "../pool-events.mjs";
import { proxyToRelayer } from "../relayer-proxy.mjs";

export const l2Router = Router();

/** Resolve `:chain`, or answer with the 404 that `requireEvmL2` shaped. */
function resolve(req, res, extra = {}) {
  try {
    return requireEvmL2(req.params.chain);
  } catch (error) {
    res.status(error.status ?? 500).json({ error: error.message, ...extra });
    return null;
  }
}

l2Router.get("/:chain/index", async (req, res) => {
  const chain = resolve(req, res, { configured: false, candidates: [], proofs: [] });
  if (!chain) return undefined;

  const l1 = getL1();
  if (!l1.rpcUrl || !l1.poolAddress) {
    return res.json({ configured: false, candidates: [], proofs: [] });
  }

  try {
    const [deliveries, lifecycle, scope] = await Promise.all([
      readL1L2Notes(),
      readEvmL2NoteEvents(chain),
      evmL2Scope(chain),
    ]);
    const { received, activated } = lifecycle;

    const candidates = buildScannableNotes(deliveries, received);
    const tree = reconstructL2StateTree(activated);
    const proofs = activated.map((event) => {
      const index = tree.indexOf(event.commitment);
      return {
        commitment: event.commitment.toString(),
        index,
        depth: tree.depth,
        proof: index >= 0 ? tree.generateProof(index) : null,
      };
    });

    return res.json({
      configured: true,
      scope: scope.toString(),
      stateRoot: (tree.root ?? 0n).toString(),
      candidates: candidates.map((note) => ({
        ...note,
        commitment: note.commitment.toString(),
        value: note.value.toString(),
        ephemeralKey: note.ephemeralKey.map((part) => part.toString()),
      })),
      proofs: JSON.parse(
        JSON.stringify(proofs, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
      ),
    });
  } catch (error) {
    console.warn(`[L2 INDEX ERROR ${chain.key}]`, error instanceof Error ? error.stack : error);
    return res.status(502).json({
      configured: true,
      error: errorMessage(error, "Unable to index Mode-3 notes"),
      candidates: [],
      proofs: [],
    });
  }
});

l2Router.get("/:chain/config", async (req, res) => {
  const chain = resolve(req, res);
  if (!chain) return undefined;
  try {
    // Both must succeed: a destination the relayer cannot sign for is not usable,
    // and neither is one whose pool we cannot read.
    const [scope, signer] = await Promise.all([evmL2Scope(chain), destinationSigner(chain.key)]);
    return res.json({
      configured: Boolean(signer.configured),
      chainId: chain.chainId,
      chainName: chain.chainName,
      poolAddress: chain.poolAddress,
      scope: scope.toString(),
      relayerAddress: signer.relayerAddress ?? null,
    });
  } catch (error) {
    return res.status(502).json({ error: errorMessage(error, "Unable to read L2 configuration") });
  }
});

l2Router.get("/:chain/status/:commitment", async (req, res) => {
  const chain = resolve(req, res);
  if (!chain) return undefined;
  try {
    const commitment = BigInt(req.params.commitment);
    const [received, pendingValue, currentRoot] = await multicall(chain, [
      { address: chain.poolAddress, abi: l2StatusAbi, functionName: "receivedCommitments", args: [commitment] },
      { address: chain.poolAddress, abi: l2StatusAbi, functionName: "pendingValue", args: [commitment] },
      { address: chain.poolAddress, abi: l2StatusAbi, functionName: "currentRoot" },
    ]);
    return res.json({
      received,
      pendingValue: pendingValue.toString(),
      currentRoot: currentRoot.toString(),
      // The three states of the unordered two-op bridge split (CLAUDE.md §6): the
      // note has not arrived, it has arrived but its tokens have not, or it is live.
      state: !received
        ? "bridge-pending"
        : pendingValue > 0n
          ? "received-pending-activation"
          : "activated",
    });
  } catch (error) {
    return res.status(502).json({ error: errorMessage(error, "Unable to read L2 status") });
  }
});

// Destination writes are the relayer's job; the app server only forwards them.
l2Router.post(
  "/:chain/activate",
  proxyToRelayer((req) => `/relayer/destinations/${encodeURIComponent(req.params.chain)}/activate`, {
    unavailable: "L2 activation failed",
  }),
);

l2Router.post(
  "/:chain/withdraw",
  proxyToRelayer((req) => `/relayer/destinations/${encodeURIComponent(req.params.chain)}/withdraw`, {
    unavailable: "L2 withdrawal failed",
  }),
);

/**
 * Destination scanning — the app server's half of the activation split.
 *
 * The app server owns *discovery* because it already owns the indexing stack (event
 * cursors, head coalescing, per-chain concurrency limits) and already reads these
 * exact events to serve `/api/l2/:chain/index`. It nominates backed pending notes;
 * the relayer holds the keys, re-verifies each nomination against fresh chain state,
 * and signs. Neither component polls the other's job.
 */
import { getEvmL2s, getScanConfig } from "./config.mjs";
import { multicall, readEvmL2NoteEvents } from "./evm-reads.mjs";
import { l2BackingAbi } from "./pool-events.mjs";
import { fetchFromRelayer } from "./relayer-proxy.mjs";
import { rpcRuntime } from "./rpc-runtime.mjs";

/**
 * Whether the relayer can sign for a destination, and with which address.
 *
 * This used to be derived from a local private key. The relayer is the only key
 * holder now, so it is the only component that can answer — but the answer is needed
 * on every withdrawal (the client binds `relayerAddress` as the L2 `processooor`), so
 * it is cached briefly. It changes only when the relayer restarts.
 */
export function destinationSigner(key) {
  return rpcRuntime.cachedRead(
    `destination-signer:${key}`,
    () => fetchFromRelayer(`/relayer/destinations/${encodeURIComponent(key)}`),
    { maxAgeMs: Number(process.env.RELAYER_DETAILS_TTL_MS ?? 30_000) },
  );
}

/** Read one EVM destination's pending notes and remaining bridge backing. */
export async function scanEvmDestination(chain) {
  const [lifecycle, [activatedSupply, tokensReceived]] = await Promise.all([
    readEvmL2NoteEvents(chain),
    multicall(chain, [
      { address: chain.poolAddress, abi: l2BackingAbi, functionName: "activatedSupply" },
      { address: chain.poolAddress, abi: l2BackingAbi, functionName: "tokensReceivedFromBridge" },
    ]),
  ]);
  return { ...lifecycle, activatedSupply, tokensReceived };
}

/**
 * The destinations to scan, all paced at the same active interval.
 *
 * EVM only, deliberately. Starknet is NOT scanned: `_bridgeStarknet` delivers value and
 * commitment in one `depositWithMessage`, StarkGate credits the tokens before invoking
 * `on_receive`, and `_try_activate` therefore succeeds inline — a Starknet note is
 * spendable in its delivery transaction and never sits pending. The Cairo pool's
 * `#[l1_handler] receive_note` entrypoint is the only path that could leave one pending,
 * and nothing can reach it: no L1 code sends a raw Starknet Core message, and the handler
 * asserts `from_address == l1_pool` so no third party can drive it either.
 *
 * Scanning it anyway cost four RPC reads per idle tick, forever, to confirm a state that
 * cannot arise. If a raw Core-message path is ever restored on L1, re-add a destination
 * here that scans `NoteReceived`/`NoteActivated` and `tokens_received_from_bridge`.
 */
export function activationDestinations() {
  const { enabled, pollMs, idlePollMs, activeWindowMs } = getScanConfig();
  if (!enabled) return [];

  const destinations = getEvmL2s().map((chain) => ({
    id: `evm:${chain.key}`,
    key: chain.key,
    label: chain.chainName,
    pollMs,
    idlePollMs,
    activeWindowMs,
    scan: () => scanEvmDestination(chain),
  }));

  return destinations;
}

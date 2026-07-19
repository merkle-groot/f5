/**
 * Destination scanning — the app server's half of the activation split.
 *
 * The app server owns *discovery* because it already owns the indexing stack (event
 * cursors, head coalescing, per-chain concurrency limits) and already reads these
 * exact events to serve `/api/l2/:chain/index`. It nominates backed pending notes;
 * the relayer holds the keys, re-verifies each nomination against fresh chain state,
 * and signs. Neither component polls the other's job.
 */
import {
  getEvmL2s,
  getScanConfig,
  getStarknetConfig,
  starknetConfigured,
  STARKNET_DESTINATION_KEY,
} from "./config.mjs";
import { multicall, readEvmL2NoteEvents } from "./evm-reads.mjs";
import { l2BackingAbi } from "./pool-events.mjs";
import { fetchFromRelayer } from "./relayer-proxy.mjs";
import { rpcRuntime } from "./rpc-runtime.mjs";
import { getNoteLifecycleEvents, getStarknetProvider, getTokensReceived } from "./starknet-reads.mjs";

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

export async function scanStarknetDestination(config) {
  const provider = getStarknetProvider(config);
  const [lifecycle, tokensReceived] = await Promise.all([
    getNoteLifecycleEvents(provider, config),
    getTokensReceived(provider, config),
  ]);
  const { received, activated } = lifecycle;
  return {
    received,
    activated,
    tokensReceived,
    // The Cairo pool exposes no `activated_supply` getter, so it is summed from the
    // activation events — equal by construction, since each activation emits once.
    activatedSupply: activated.reduce((total, event) => total + event.value, 0n),
  };
}

/**
 * The destinations to scan, all paced at the same active interval.
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

  if (starknetConfigured()) {
    const starknet = getStarknetConfig();
    destinations.push({
      id: "starknet",
      key: STARKNET_DESTINATION_KEY,
      label: starknet.chainName,
      pollMs,
      idlePollMs,
      activeWindowMs,
      scan: () => scanStarknetDestination(starknet),
    });
  }
  return destinations;
}

/**
 * All EVM chain reads — L1 pool and every EVM L2 destination.
 *
 * Everything goes through the shared `rpcRuntime` (one client per chain, coalesced
 * head reads, cached view reads) and the shared `eventIndex` (incremental log
 * cursors, per-chain concurrency limits). Adding a read anywhere else in the server
 * means adding an unmetered, unthrottled RPC stream, which is exactly what caused the
 * rate-limit problem this layer exists to prevent.
 */
import { getL1, MULTICALL3_ADDRESS, REORG_BUFFER } from "./config.mjs";
import { EventIndex } from "./event-index.mjs";
import {
  depositedEvent,
  depositedKey,
  l2NoteEvent,
  l2NoteKey,
  noteLifecycleEvents,
  noteLifecycleKey,
  parseCommitmentValueLog,
  parseDepositLog,
  parseL2NoteLog,
  scopeAbi,
} from "./pool-events.mjs";
import { retryRpc } from "./rpc-retry.mjs";
import { rpcRuntime } from "./rpc-runtime.mjs";

/**
 * Retry a transient RPC failure with backoff. Public nodes answer `-32603 service
 * temporarily unavailable` under load, and one blip should not fail a withdrawal's
 * state proof.
 */
export async function withRetry(fn, attempts = 4) {
  return retryRpc(fn, { attempts });
}

export const eventIndex = new EventIndex({
  runtime: rpcRuntime,
  reorgBuffer: REORG_BUFFER,
  retry: withRetry,
});

export function evmClient(chainId, rpcUrl) {
  return rpcRuntime.client(`evm:${chainId}`, rpcUrl);
}

export function l1Client(rpcUrl = getL1().rpcUrl) {
  return evmClient(getL1().chainId, rpcUrl);
}

/** Read one L1 pool event stream from the pool's deployment block. */
export function readL1Event(event, eventKey, { force = false } = {}) {
  const l1 = getL1();
  return eventIndex.read({
    chain: `evm:${l1.chainId}`,
    rpcUrl: l1.rpcUrl,
    address: l1.poolAddress,
    event,
    eventKey,
    fromBlock: l1.deploymentBlock,
    force,
  });
}

export async function getDepositEvents({ force = false } = {}) {
  const l1 = getL1();
  if (!l1.rpcUrl || !l1.poolAddress) throw new Error("Pool indexing is not configured");
  return (await readL1Event(depositedEvent, depositedKey, { force })).map(parseDepositLog);
}

/** The Mode-3 stealth deliveries emitted on L1, for every destination. */
export async function readL1L2Notes() {
  return (await readL1Event(l2NoteEvent, l2NoteKey)).map(parseL2NoteLog);
}

/** Read and partition both destination note lifecycle events with one log filter. */
export async function readEvmL2NoteEvents(chain) {
  const logs = await eventIndex.read({
    chain: `evm:${chain.chainId}`,
    rpcUrl: chain.rpcUrl,
    address: chain.poolAddress,
    events: noteLifecycleEvents,
    eventKey: noteLifecycleKey,
    fromBlock: BigInt(chain.deploymentBlock ?? "0"),
  });
  const received = [];
  const activated = [];
  for (const log of logs) {
    if (log.eventName === "NoteReceived") {
      received.push(parseCommitmentValueLog(log, "NoteReceived"));
    } else if (log.eventName === "NoteActivated") {
      activated.push(parseCommitmentValueLog(log, "NoteActivated"));
    } else {
      throw new Error(`Unexpected L2 note lifecycle event ${String(log.eventName)}`);
    }
  }
  return { received, activated };
}

/** A pool's SCOPE never changes, so it is cached without expiry. */
export function evmL2Scope(chain) {
  return rpcRuntime.cachedRead(
    `evm-scope:${chain.chainId}:${chain.poolAddress.toLowerCase()}`,
    () =>
      evmClient(chain.chainId, chain.rpcUrl).readContract({
        address: chain.poolAddress,
        abi: scopeAbi,
        functionName: "SCOPE",
      }),
  );
}

/**
 * Batch several views on one chain into a single call.
 *
 * Used wherever the results are compared or subtracted: reading them separately lets
 * them straddle a block boundary and produce a combined answer that was never true at
 * any single block. Halving the call count is the secondary benefit.
 */
export function multicall(chain, contracts) {
  return withRetry(() =>
    evmClient(chain.chainId, chain.rpcUrl).multicall({
      allowFailure: false,
      multicallAddress: MULTICALL3_ADDRESS,
      contracts,
    }),
  );
}

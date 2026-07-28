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
  l1PoolEvents,
  l1PoolKey,
  noteLifecycleEvents,
  noteLifecycleKey,
  parseCommitmentValueLog,
  parseDepositLog,
  parseL2NoteLog,
  parseL2WithdrawnLog,
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
    chunkBlocks: l1.logChunkBlocks,
    force,
  });
}

/** Read the pool's complete public event surface through one shared cursor. */
export function readL1PoolEvents({ force = false } = {}) {
  const l1 = getL1();
  return eventIndex.read({
    chain: `evm:${l1.chainId}`,
    rpcUrl: l1.rpcUrl,
    address: l1.poolAddress,
    events: l1PoolEvents,
    eventKey: l1PoolKey,
    fromBlock: l1.deploymentBlock,
    chunkBlocks: l1.logChunkBlocks,
    force,
  });
}

export async function getDepositEvents({ force = false } = {}) {
  const l1 = getL1();
  if (!l1.rpcUrl || !l1.poolAddress) throw new Error("Pool indexing is not configured");
  return (await readL1PoolEvents({ force }))
    .filter((log) => log.eventName === depositedEvent.name)
    .map(parseDepositLog);
}

/**
 * Every event that makes an L1 note unspendable, indexed as one RPC log stream.
 *
 * Keeping Withdrawn and Ragequit together avoids scanning the same L1 block ranges
 * twice. Consumers partition the cached logs locally, which costs no RPC calls.
 */
export async function readL1SpendEvents({ force = false } = {}) {
  const logs = await readL1PoolEvents({ force });
  return {
    withdrawals: logs.filter((log) => log.eventName === "Withdrawn"),
    ragequits: logs.filter((log) => log.eventName === "Ragequit"),
  };
}

/** The Mode-3 stealth deliveries emitted on L1, for every destination. */
export async function readL1L2Notes() {
  return (await readL1PoolEvents())
    .filter((log) => log.eventName === "L2Note")
    .map(parseL2NoteLog);
}

/**
 * Read and partition all three destination note lifecycle events with one log filter.
 *
 * `force` replays the stream from the deployment block instead of trusting the cache.
 * The incremental path advances its cursor to `head - reorgBuffer` on the strength of
 * the head returned by `eth_blockNumber`; a load-balanced RPC can serve the `eth_getLogs`
 * for that same window from a backend that is further behind, in which case a
 * `NoteActivated` is skipped and — because the cursor has already moved past it —
 * never refetched. One missing leaf silently changes every subsequent tree root.
 */
export async function readEvmL2NoteEvents(chain, { force = false } = {}) {
  const logs = await eventIndex.read({
    chain: `evm:${chain.chainId}`,
    rpcUrl: chain.rpcUrl,
    address: chain.poolAddress,
    events: noteLifecycleEvents,
    eventKey: noteLifecycleKey,
    fromBlock: BigInt(chain.deploymentBlock ?? "0"),
    chunkBlocks: chain.logChunkBlocks,
    force,
  });
  const received = [];
  const activated = [];
  const spent = [];
  for (const log of logs) {
    if (log.eventName === "NoteReceived") {
      received.push(parseCommitmentValueLog(log, "NoteReceived"));
    } else if (log.eventName === "NoteActivated") {
      activated.push(parseCommitmentValueLog(log, "NoteActivated"));
    } else if (log.eventName === "Withdrawn") {
      spent.push(parseL2WithdrawnLog(log));
    } else {
      throw new Error(`Unexpected L2 note lifecycle event ${String(log.eventName)}`);
    }
  }
  return { received, activated, spent };
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

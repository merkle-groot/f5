/**
 * All Starknet chain reads.
 *
 * Separate from `evm-reads.mjs` for two structural reasons, not stylistic ones:
 * values are felt pairs rather than 256-bit words, and Starknet has no Multicall3, so
 * batching is `Promise.all` over individual calls rather than one round trip.
 */
import { RpcProvider, hash as snHash } from "starknet";
import { getStarknetConfig } from "./config.mjs";
import { withRetry } from "./evm-reads.mjs";
import { rpcRuntime } from "./rpc-runtime.mjs";
import { StarknetEventIndex } from "./starknet-event-index.mjs";

/** A Cairo `u256` is two felts: [low, high]. */
export const fromU256 = (low, high) => BigInt(low) + (BigInt(high) << 128n);

export function toU256(value) {
  const number = BigInt(value);
  const mask = (1n << 128n) - 1n;
  return [number & mask, number >> 128n].map((part) => part.toString());
}

const providers = new Map();

export function getStarknetProvider(config = getStarknetConfig()) {
  if (!config.rpcUrl) throw new Error("STARKNET_RPC_URL is not configured");
  let provider = providers.get(config.rpcUrl);
  if (!provider) {
    provider = new RpcProvider({ nodeUrl: config.rpcUrl });
    providers.set(config.rpcUrl, provider);
  }
  return provider;
}

const eventIndex = new StarknetEventIndex({ retry: withRetry, reorgBuffer: 16 });
const NOTE_RECEIVED = "NoteReceived";
const NOTE_ACTIVATED = "NoteActivated";
const noteLifecycleNames = [NOTE_RECEIVED, NOTE_ACTIVATED];
const noteLifecycleSelectors = noteLifecycleNames.map((name) => snHash.getSelectorFromName(name));

/** Call a Cairo entrypoint that returns a single `u256`. */
async function callU256(provider, config, entrypoint, calldata = []) {
  const [low, high] = await withRetry(() =>
    provider.callContract({ contractAddress: config.poolAddress, entrypoint, calldata }, "latest"),
  );
  return fromU256(low, high);
}

/**
 * The L1 pool this Starknet pool will accept notes from.
 *
 * `receive_note` asserts `from_address == l1_pool`, and `l1_pool` is IMMUTABLE
 * (set in the constructor). If our L1 pool is not the bound one, a Starknet relay
 * is a trap: StarkGate still delivers the ETH, but the note message reverts with
 * `NotL1Pool` — so the value lands in the Cairo pool with NO note that can ever
 * claim it. That is unrecoverable, so we check before offering Starknet at all.
 *
 * There is no `l1_pool()` getter in the pool's interface, but it is a plain storage
 * var, so its slot is `sn_keccak("l1_pool")`.
 */
export function getBoundL1Pool(provider, config) {
  return rpcRuntime.cachedRead(
    `starknet-bound-l1:${config.chainId}:${config.poolAddress.toLowerCase()}`,
    async () => {
      const slot = snHash.starknetKeccak("l1_pool").toString(16);
      // Retry so a transient RPC blip (Infura throws -32603 under load) does not
      // fail-close the whole destination: a single throw here leaves `l1PoolMatches`
      // null, which the UI renders as "STARKNET DISABLED — unreachable". Pin to
      // `latest` rather than the default `pending`: `l1_pool` is immutable so they
      // agree, and some nodes (Alchemy v0.10) reject `pending` with -32602.
      const raw = await withRetry(() =>
        provider.getStorageAt(config.poolAddress, `0x${slot}`, "latest"),
      );
      return BigInt(typeof raw === "string" ? raw : raw.value);
    },
  );
}

export function getScope(provider, config) {
  return rpcRuntime.cachedRead(
    `starknet-scope:${config.chainId}:${config.poolAddress.toLowerCase()}`,
    () => callU256(provider, config, "scope"),
  );
}

/** The root moves every block, so this is cached only for the head TTL. */
export function getRoot(provider, config) {
  return rpcRuntime.cachedRead(
    `starknet-root:${config.chainId}:${config.poolAddress.toLowerCase()}`,
    () => callU256(provider, config, "current_root"),
    { maxAgeMs: Number(process.env.RPC_HEAD_TTL_MS ?? 2500) },
  );
}

export function getPendingValue(provider, config, commitment) {
  return callU256(provider, config, "pending_value", toU256(commitment));
}

export function getTokensReceived(provider, config) {
  return callU256(provider, config, "tokens_received_from_bridge");
}

/**
 * Read a Cairo pool event across all pages.
 *
 * `commitment` is `#[key]`-tagged in the Cairo event, so it lands in `keys` (as a
 * u256 = two felts, after the selector) while `value` lands in `data`.
 */
export async function getEvents(provider, config, eventName) {
  const events = await eventIndex.read({
    rpcUrl: config.rpcUrl,
    provider,
    address: config.poolAddress,
    eventName,
    selector: snHash.getSelectorFromName(eventName),
    fromBlock: config.deploymentBlock,
  });
  return events.map((event) => ({
    commitment: fromU256(event.keys[1], event.keys[2]),
    value: fromU256(event.data[0], event.data[1]),
  }));
}

/** Read and partition both destination note lifecycle events with one selector filter. */
export async function getNoteLifecycleEvents(provider, config) {
  const events = await eventIndex.read({
    rpcUrl: config.rpcUrl,
    provider,
    address: config.poolAddress,
    eventNames: noteLifecycleNames,
    selectors: noteLifecycleSelectors,
    fromBlock: config.deploymentBlock,
  });
  const received = [];
  const activated = [];
  for (const event of events) {
    const parsed = {
      commitment: fromU256(event.keys[1], event.keys[2]),
      value: fromU256(event.data[0], event.data[1]),
    };
    const selector = BigInt(event.keys[0]);
    if (selector === BigInt(noteLifecycleSelectors[0])) received.push(parsed);
    else if (selector === BigInt(noteLifecycleSelectors[1])) activated.push(parsed);
    else throw new Error(`Unexpected Starknet note lifecycle selector ${event.keys[0]}`);
  }
  return { received, activated };
}

/**
 * Whether the Starknet destination's reported status is worth asking about again.
 *
 * Split out because the distinction is a correctness question, not a UI one: retrying a
 * permanent misconfiguration polls forever and still shows the same banner, while NOT
 * retrying a transient one latches a wrong answer on screen until the page reloads.
 * The app has hit the second failure — see `loadStarknetStatus`.
 */

/** Fast retries before falling back to the once-a-minute refresh. */
export const STARKNET_STATUS_RETRIES = 5;

/** 500ms doubling to a 5s ceiling: a boot race resolves in ~12s across the retries. */
export function starknetRetryDelayMs(attempt) {
  return Math.min(500 * 2 ** attempt, 5000);
}

/**
 * `true` when a later attempt could plausibly answer differently.
 *
 * Transient: the API is unreachable (`unavailable`), or the relayer has not reported
 * its Starknet keys yet (`relayerReady === false`) — which is what an app server that
 * started before the relayer bound its port looks like.
 *
 * Permanent, and deliberately NOT retried: `l1PoolMatches === false`. The Cairo pool's
 * `l1_pool` is immutable and `receive_note` asserts against it, so a pool bound to a
 * different L1 pool needs a redeploy. Polling changes nothing, and the destination must
 * stay disabled — bridging to it would deliver the ETH and then reject the note,
 * stranding the value with nothing able to claim it.
 */
export function starknetStatusUnsettled(status) {
  if (!status || typeof status !== "object") return true;
  if (status.unavailable) return true;
  if (status.l1PoolMatches === false) return false;
  return status.relayerReady === false;
}
